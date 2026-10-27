/**
 * Deterministic post-processor for the Confluence plugin's two lists: a
 * `page search` result and a `page children` result. It recognizes their
 * shape and emits, on the user-facing `display` channel (see `ToolDisplay`),
 * one structured record per page (`page-list`) or per child (`child-pages`),
 * never a pre-rendered string: turning the records into text is the
 * instance's formatter rule for that kind. The links come from the CLI
 * (`link`, built from the site the login belongs to), so the plugin needs no
 * site URL of its own.
 *
 * It runs after every allowed command and acts only on those two prefixes,
 * passing every other result through untouched. `--select` can reshape the
 * JSON into anything, so it classifies defensively: a non-object payload
 * passes through; a payload with no `results` array, or results pruned of a
 * field the list needs, keeps its data and gets a model-facing
 * `formattedListNote` naming the select to rerun with, and no display.
 */
import type { CliPostProcessor, CliResult } from "@mercury-fw/plugin-types";

/** The `--select` for `confluence page search` that yields a formattable
 * list: each result's id, title and type (to keep pages and blog posts only),
 * its space, excerpt and link, plus the total number of matches. The CLI
 * refuses a search without `--select`, so the note and the skill name this
 * one. */
export const CONFLUENCE_PAGE_LIST_SELECT =
  "results.content.id,results.content.title,results.content.type,results.resultGlobalContainer.title,results.excerpt,results.link,totalSize";

/** The `--select` for `confluence page children` that yields a formattable
 * list: each child's id, title, type and link, plus the next page's cursor. */
export const CONFLUENCE_CHILD_PAGES_SELECT = "results.id,results.title,results.type,results.link,nextCursor";

/** One page (or blog post) in a search result, as emitted on the `display`
 * channel. `space`, `excerpt` and `url` are `null` when the result has none
 * (an empty excerpt counts as none). */
export type ConfluencePageListItem = { id: string; title: string; space: string | null; excerpt: string | null; url: string | null };

/** One child of a page, as emitted on the `display` channel: `type` is page,
 * folder, whiteboard, database or embed (`null` when not selected), `url` is
 * `null` for a child the CLI gives no link to (anything but a page). */
export type ConfluenceChildPage = { id: string; title: string; type: string | null; url: string | null };

/** The content types a search result is listed for: what a person reads as
 * a page. Attachments, comments and the like stay in the model's data only. */
const LISTED_TYPES = new Set(["page", "blogpost"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * `formattedListNote` is added to the tool's result after the CLI runs, so
 * `--select` (evaluated by the CLI on its own output) can never reach it:
 * the note says so, the same lesson as the Jira plugin's.
 */
function cannotFormatNote(what: string, select: string): string {
  return (
    `Could not build a formatted ${what} from this result. Note: formattedListNote is added by the system ` +
    "after the confluence CLI runs, it is not part of the CLI's JSON and can never be reached with --select. " +
    `If the user wants the formatted list, rerun the same command with --select ${select}.`
  );
}

/** A search result: the listed items, or `null` when a result that has
 * content lacks an id, a title or a type (a pruned select). Results without
 * content (spaces, users) are skipped. */
function searchItems(results: unknown[]): ConfluencePageListItem[] | null {
  const items: ConfluencePageListItem[] = [];
  for (const result of results) {
    if (!isPlainObject(result) || !isPlainObject(result.content)) continue;
    const { id, title, type } = result.content;
    if (typeof id !== "string" || typeof title !== "string" || typeof type !== "string") return null;
    if (!LISTED_TYPES.has(type)) continue;
    const space = isPlainObject(result.resultGlobalContainer) ? result.resultGlobalContainer.title : undefined;
    items.push({ id, title, space: stringOrNull(space), excerpt: stringOrNull(result.excerpt), url: stringOrNull(result.link) });
  }
  return items;
}

/** A children result: the listed items, or `null` when a child lacks an id
 * or a title (a pruned select, or not a child at all). */
function childItems(results: unknown[]): ConfluenceChildPage[] | null {
  const items: ConfluenceChildPage[] = [];
  for (const child of results) {
    if (!isPlainObject(child) || typeof child.id !== "string" || typeof child.title !== "string") return null;
    items.push({ id: child.id, title: child.title, type: stringOrNull(child.type), url: stringOrNull(child.link) });
  }
  return items;
}

/** The plugin's `CliPostProcessor`, which an instance may wrap with a
 * formatter at composition to render the `page-list` and `child-pages`
 * displays. */
export const confluencePageListExtractor: CliPostProcessor = (cmd, result): CliResult => {
  const command = cmd.prefix.join(" ");
  if ((command !== "page search" && command !== "page children") || !result.ok || !isPlainObject(result.data)) {
    return result;
  }
  const data = result.data;
  const search = command === "page search";
  const note = search
    ? cannotFormatNote("page list", CONFLUENCE_PAGE_LIST_SELECT)
    : cannotFormatNote("list of child pages", CONFLUENCE_CHILD_PAGES_SELECT);
  if (!Array.isArray(data.results)) {
    return { ok: true, data: { ...data, formattedListNote: note } };
  }

  if (search) {
    const items = searchItems(data.results);
    if (items === null) return { ok: true, data: { ...data, formattedListNote: note } };
    // The count of this page's listed pages, so the model reads it instead
    // of counting a long array itself.
    return { ok: true, data: { ...data, pageCount: items.length }, display: { type: "page-list", items } };
  }

  const items = childItems(data.results);
  if (items === null) return { ok: true, data: { ...data, formattedListNote: note } };
  return { ok: true, data, display: { type: "child-pages", items } };
};
