/**
 * The facts the tasks expect, held against the made-up Jira: for each task
 * with a count or a set of issues to find, a reference run (the right JQL,
 * answered by the real fixtures, every page read) has to pass its checks. A
 * seed changed in world.ts moves the reference answer; a task whose number
 * didn't move with it fails here.
 */
import { describe, expect, test } from "bun:test";
import { createExpect } from "../../../../apps/cli/src/e2e/expect.ts";
import { createFakeCli } from "../../../../apps/skill-trainer/src/fixtures.ts";
import type { Call, Run } from "../../../../apps/skill-trainer/src/contract.ts";
import training from "./index.ts";
import { jiraFixtures, makeWorld } from "./world.ts";

const readSkill: Call = { tool: "read_skill", input: { name: "jira" }, output: {}, ok: true, pending: false };

/** The searches a careful model makes for `jql`, every page of it, as calls with their real answers; and the keys found. */
async function searchAll(jql: string): Promise<{ calls: Call[]; keys: string[] }> {
  const cli = createFakeCli(jiraFixtures(makeWorld()));
  const calls: Call[] = [];
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const args = ["issue", "search", "--jql", jql, "--max-results", "100", "--select", "issues.key,nextPageToken", ...(token ? ["--page-token", token] : [])];
    const output = await cli.run("jira", args);
    const command = `jira issue search --jql ${JSON.stringify(jql)} --max-results 100 --select issues.key,nextPageToken${token ? ` --page-token ${token}` : ""}`;
    calls.push({ tool: "jiraCommand", input: { command }, output, ok: output.ok, pending: false });
    if (!output.ok) throw new Error(`reference JQL refused: ${jql}: ${output.error}`);
    const data = output.data as { issues: Array<{ key: string }>; nextPageToken?: string };
    keys.push(...data.issues.map((i) => i.key));
    token = data.nextPageToken;
  } while (token !== undefined);
  return { calls, keys };
}

/** The failed checks of task `id` on a reference run of `jql` (after the `before` calls: a wiki grep,
 * a project search), answered with the count and the keys found. */
async function reference(id: string, jql: string, before: Call[] = []): Promise<string[]> {
  const { calls, keys } = await searchAll(jql);
  const turn = { calls: [readSkill, ...before, ...calls], answer: `${keys.length} issues: ${keys.join(", ")}.`, seconds: 1 };
  const run: Run = { turns: [turn], last: turn };
  const recorder = createExpect(run);
  const task = training.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  task.check(run, recorder.expect);
  return recorder.checks().filter((c) => !c.ok).map((c) => `${c.label}${c.detail ? ` (${c.detail.slice(0, 80)})` : ""}`);
}

const OPEN = "statusCategory != Done";
const CASES: Array<[string, string]> = [
  ["count-web-open", `project = WEB AND ${OPEN}`],
  ["count-ops-open", `project = OPS AND ${OPEN}`],
  ["count-mrt-open", `project = MRT AND ${OPEN}`],
  ["count-dsk-open", `project = DSK AND ${OPEN}`],
  ["count-web-bugs", `project = WEB AND issuetype = Bug AND ${OPEN}`],
  ["count-marco", `assignee = "Marco Bianchi" AND ${OPEN}`],
  ["count-giulia", `assignee = "Giulia Ferri" AND ${OPEN}`],
  ["count-log-paged", `project = LOG AND ${OPEN}`],
  ["mine-open", `assignee = currentUser() AND ${OPEN}`],
  ["wording-todo", 'project = WEB AND status = "To Do"'],
  ["wording-review", 'project = WEB AND status = "In Review"'],
  ["wording-progress", 'project = OPS AND status = "In Progress"'],
  ["dates-overdue", `project = WEB AND ${OPEN} AND duedate < now()`],
  ["dates-created-week", "project = OPS AND created >= -7d"],
  ["dates-due-soon", `project = DSK AND ${OPEN} AND duedate >= now() AND duedate <= 5d`],
  ["h-count-it-web", `project = WEB AND ${OPEN}`],
  ["h-count-all-bugs", `issuetype = Bug AND ${OPEN}`],
  ["h-count-log-total", "project = LOG"],
  ["h-count-it-log-todo", 'project = LOG AND status = "To Do"'],
  ["h-count-ada-conti", `assignee = "Ada Conti" AND ${OPEN}`],
  ["h-count-my-bugs", `assignee = currentUser() AND issuetype = Bug AND ${OPEN}`],
  ["h-count-it-unassigned", `project in (WEB, OPS) AND assignee is EMPTY AND ${OPEN}`],
  ["h-count-highest", `priority = Highest AND ${OPEN}`],
  ["h-count-it-giulia", `assignee = "Giulia Ferri" AND ${OPEN}`],
  ["h-wording-it-todo", 'project = OPS AND status = "To Do"'],
  ["h-wording-closed", "project = WEB AND status = Done"],
  ["h-wording-wip", 'project = MRT AND status = "In Progress"'],
  ["h-wording-it-review", 'project = OPS AND status = "In Review"'],
  ["h-dates-due-week", "project = WEB AND duedate >= now() AND duedate <= 7d"],
  ["h-dates-it-no-due", `project = WEB AND ${OPEN} AND duedate is EMPTY`],
  ["h-mine-it-count", `assignee = currentUser() AND ${OPEN}`],
  ["h-count-lena", `assignee = "Lena Hoffmann" AND ${OPEN}`],
  ["someone-else", `assignee = "Ada Moretti" AND ${OPEN}`],
  ["h-mine-in-progress", 'assignee = currentUser() AND status = "In Progress"'],
  ["h-dates-it-mine-overdue", `assignee = currentUser() AND ${OPEN} AND duedate < now()`],
  ["h-list-keys-only", `project = OPS AND issuetype = Bug AND ${OPEN}`],
];

/** A tool call that worked, for the steps a reference run takes before its search. */
const ok = (tool: string, input: Record<string, unknown>): Call => ({ tool, input, output: { ok: true }, ok: true, pending: false });
const grep = (pattern: string) => ok("grep", { pattern });
const projectSearch = (query: string) => ok("jiraCommand", { command: `jira project search --query ${query} --select values.key,values.name` });

/** Tasks whose right run looks something up before it searches. */
const CASES_AFTER_LOOKUP: Array<[string, string, Call[]]> = [
  ["h-wiki-hit", `project = WEB AND ${OPEN}`, [grep("shop")]],
  ["h-informal-it-desk", `project = DSK AND ${OPEN}`, [grep("help desk"), projectSearch("desk")]],
  ["informal-project-logs", `project = LOG AND ${OPEN}`, [grep("log archive"), projectSearch("log")]],
];

describe("the tasks' facts follow from the made-up Jira", () => {
  for (const [id, jql] of CASES) {
    test(`${id}: the right search answered right passes`, async () => {
      expect(await reference(id, jql)).toEqual([]);
    });
  }
  for (const [id, jql, before] of CASES_AFTER_LOOKUP) {
    test(`${id}: the right lookup and search answered right passes`, async () => {
      expect(await reference(id, jql, before)).toEqual([]);
    });
  }
});
