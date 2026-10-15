/**
 * Deterministic post-processor for a `jira issue search` result — the
 * *extraction* half of Jira's issue-list handling. It recognizes the shape of a
 * search result and emits, on the user-facing `display` channel (see
 * `ToolDisplay`, `type: "issue-list"`), one **structured record** per issue
 * (`{ key, status, summary, url }`) — never a pre-rendered string. Turning those
 * records into text is the instance's formatter rule for `issue-list`, written
 * in its config; the plugin owns only what it can know from the data: the
 * fields, and the browse `url` resolved from `siteUrl`.
 *
 * It is the plugin's single post-processor, so it runs after every allowed
 * command and acts only when the matched prefix is `issue search`, passing
 * every other result through untouched. `--select` can reshape the JSON into anything, so
 * it classifies defensively: a non-object payload passes through untouched; a
 * payload with no `issues` array, or issues pruned of `key` or `summary`, keeps
 * its data and gets a model-facing `formattedListNote` (no display). Every
 * result with an `issues` array also gets `issueCount`, that page's length.
 * `siteUrl` (the team's browsable Jira host) isn't derivable from any CLI
 * output, so it's a deployment constant carried in the plugin's config.
 *
 * `CliResult`/`CliPostProcessor` come from `@mercury-fw/plugin-types`, the shared
 * contract both the core and the plugins import.
 */
import type { CliResult, CliPostProcessor } from "@mercury-fw/plugin-types";

/** The extractor's configuration: just `siteUrl`, the team's browsable Jira
 * site (e.g. `https://example.atlassian.net`), used to build each issue's
 * browse link. It is the extractor's only input — rendering config
 * (`itemTemplate`) moved to the render handler. The single caller (`plugin.ts`)
 * only reaches here when `JIRA_SITE_URL` is a non-empty string, so no schema
 * validation is layered on a one-required-field shape. */
export type IssueListConfig = { siteUrl: string };

/** The `--select` for `jira issue search` that yields a formattable list: the
 * key, summary and status of every issue, plus the next page's token. The CLI
 * refuses a search without `--select`, so the notes and the skill name this
 * one, and a test keeps the skill in line with it. */
export const JIRA_ISSUE_LIST_SELECT = "issues.key,issues.fields.summary,issues.fields.status.name,nextPageToken";

/** One issue as emitted on the `display` channel: `status` is the status name
 * or `null` when absent/unrequested, `url` the resolved browse link. */
export type JiraIssueListItem = { key: string; status: string | null; summary: string; url: string };

type JiraIssue = { key: string; fields?: { summary?: string; status?: { name?: string } } };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJiraIssue(value: unknown): value is JiraIssue {
  return isPlainObject(value) && typeof value.key === "string";
}

/**
 * Three outcomes, not two: `data` might not even be a plain object (a raw
 * string/array/number — genuinely foreign, nothing safe to attach a note
 * to, stays silent); might be a plain object with no `issues` array at
 * all (e.g. a bare `{}` — confirmed live, this is exactly what jira
 * returns for a `--select` path that matches nothing, like the model
 * trying `--select formattedList`); or might have an `issues` array whose
 * elements aren't full issue objects (`--select` prunes "key" off while
 * still nesting everything under `issues`, also confirmed live). The
 * latter two both deserve a `formattedListNote`, not silence.
 */
type IssueSearchShape =
  | { kind: "not-object" }
  | { kind: "no-issues-array"; data: Record<string, unknown> }
  | { kind: "issues"; data: Record<string, unknown>; issues: unknown[] };

function classifyResultData(data: unknown): IssueSearchShape {
  if (!isPlainObject(data)) {
    return { kind: "not-object" };
  }
  if (!Array.isArray(data.issues)) {
    return { kind: "no-issues-array", data };
  }
  return { kind: "issues", data, issues: data.issues };
}

/**
 * `formattedList`/`formattedListNote` are added to `runCommand`'s result
 * *after* jira itself runs — they are never part of jira's own JSON, so
 * `--select` (evaluated by jira, on jira's own raw output) can never reach
 * them. Observed live: the model tried `--select formattedList` reasoning
 * from the system prompt alone that it must be a real field — jira found
 * no such path and returned a bare `{}`, twice, with no explanation.
 */
const CANNOT_FORMAT_NOTE =
  'Could not build a formatted issue list from this result. Note: formattedList/formattedListNote are ' +
  "added by the system to runCommand's result after jira runs — they are not part of jira's own JSON and can " +
  'never be reached with --select (e.g. --select formattedList always returns {}). If the user wants a ' +
  `formatted list, rerun the same search with --select ${JIRA_ISSUE_LIST_SELECT}.`;

/** Extracts one issue into the structured `display` record: the status name or
 * `null`, and the browse `url` from `siteUrl` (trailing slash stripped). */
function extractOneIssue(issue: JiraIssue, siteUrl: string): JiraIssueListItem {
  const status = issue.fields?.status?.name;
  return {
    key: issue.key,
    status: typeof status === "string" ? status : null,
    summary: issue.fields?.summary ?? "",
    url: `${siteUrl.replace(/\/$/, "")}/browse/${issue.key}`,
  };
}

/**
 * Builds the `issue search` extractor from validated config: the plugin's
 * `CliPostProcessor`, which an instance may wrap with a formatter at
 * composition to render the `issue-list` display.
 */
export function createJiraIssueListExtractor(config: IssueListConfig): CliPostProcessor {
  const { siteUrl } = config;
  return (cmd, result): CliResult => {
    if (cmd.prefix.join(" ") !== "issue search" || !result.ok) {
      return result;
    }
    const shape = classifyResultData(result.data);
    if (shape.kind === "not-object") {
      return result;
    }
    if (shape.kind === "no-issues-array") {
      return { ok: true, data: { ...shape.data, formattedListNote: CANNOT_FORMAT_NOTE } };
    }

    // The count of this page's issues, so the model reads it instead of
    // counting a long array itself.
    const data = { ...shape.data, issueCount: shape.issues.length };
    const { issues } = shape;

    if (issues.length === 0) {
      return { ok: true, data, display: { type: "issue-list", items: [] } };
    }

    if (!issues.every(isJiraIssue)) {
      return { ok: true, data: { ...data, formattedListNote: CANNOT_FORMAT_NOTE } };
    }

    const missingSummary = issues.some((issue) => typeof issue.fields?.summary !== "string");
    if (missingSummary) {
      return { ok: true, data: { ...data, formattedListNote: CANNOT_FORMAT_NOTE } };
    }

    // Structured records on the user-facing `display` channel; the render
    // handler (composition) turns them into text. The raw `data` stays the
    // model channel, with only `issueCount` added.
    const items = issues.map((issue) => extractOneIssue(issue, siteUrl));
    return { ok: true, data, display: { type: "issue-list", items } };
  };
}
