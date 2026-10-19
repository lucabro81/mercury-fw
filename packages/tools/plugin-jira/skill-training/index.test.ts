import { describe, expect, test } from "bun:test";
import { createExpect } from "../../../../apps/cli/src/e2e/expect.ts";
import type { Call, Run } from "../../../../apps/skill-trainer/src/contract.ts";
import { selectTasks } from "../../../../apps/skill-trainer/src/harness.ts";
import training from "./index.ts";
import { ACCOUNTS } from "./world.ts";

/** A jiraCommand call that worked. */
const jira = (command: string, output: unknown = {}): Call => ({ tool: "jiraCommand", input: { command }, output, ok: true, pending: false });
const readSkill: Call = { tool: "read_skill", input: { name: "jira" }, output: {}, ok: true, pending: false };
/** A search's output that found `keys`; `next` when more pages follow. */
const found = (keys: string[], next?: string) => ({ ok: true, data: { isLast: next === undefined, issues: keys.map((key) => ({ key })), ...(next === undefined ? {} : { nextPageToken: next }) } });
const keysOf = (project: string, numbers: number[]) => numbers.map((n) => `${project}-${n}`);

/** The checks of the task `id` on turns made of `calls` and `answers`. */
function check(id: string, turns: Array<{ calls: Call[]; answer: string }>) {
  const run: Run = { turns: turns.map((t) => ({ ...t, seconds: 1 })), last: { ...turns.at(-1)!, seconds: 1 } };
  const recorder = createExpect(run);
  training.tasks.find((t) => t.id === id)!.check(run, recorder.expect);
  return recorder.checks().filter((c) => !c.ok).map((c) => c.label);
}

// Guards against checks reading the raw command line: in a live run the model
// wrote shell-escaped quotes inside --jql "…" and its right answers failed.
describe("the checks read what the model did, not how it typed it", () => {
  test("escaped quotes inside the JQL", () => {
    expect(check("wording-todo", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND status = \\"To Do\\"" --max-results 100 --select issues.key,nextPageToken')], answer: "5 WEB issues are To Do." }])).toEqual([]);
  });

  test("a small number written out", () => {
    expect(check("wording-review", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND status = \\"In Review\\"" --select issues.key')], answer: "One ticket is waiting for review in WEB: WEB-5." }])).toEqual([]);
  });

  test("the follow-up filtered by Marco's full name", () => {
    expect(
      check("followup-requery-filter", [
        { calls: [readSkill, jira('jira issue search --jql "project = WEB AND statusCategory != Done" --select issues.key')], answer: "Here they are." },
        { calls: [jira('jira issue search --jql "project = WEB AND statusCategory != Done AND assignee = \\"Marco Bianchi\\"" --select issues.key')], answer: "Only WEB-8." },
      ]),
    ).toEqual([]);
  });

  // In a live run the model's `status ~ "review"` failed, so it read every WEB
  // issue's status and counted the one in review: a right answer the status
  // check refused.
  test("a status count read off the statuses of the project's issues", () => {
    expect(
      check("wording-review", [
        {
          calls: [
            readSkill,
            { ...jira(`jira issue search --jql 'project = WEB AND status ~ "review"' --select issues.key`), ok: false },
            jira('jira issue search --jql "project = WEB" --max-results 100 --select issues.key,issues.fields.status.name'),
          ],
          answer: 'One — WEB-5 is the only WEB ticket in "In Review".',
        },
      ]),
    ).toEqual([]);
  });

  // The three below are right answers of the first full baseline run that the
  // checks refused: a create's --help taken for a create, a list shown with
  // present instead of keys in the text, a careful search taken for a guess.
  test("asking create for its help isn't creating", () => {
    expect(
      check("h-create-unknown-project", [
        {
          calls: [readSkill, jira("jira issue create --help", "Create a new issue"), { ...jira('jira issue create --project ZZZ --type Task --summary "Check the backups"'), ok: false }],
          answer: "I couldn't create it: there's no project ZZZ.",
        },
      ]),
    ).toEqual([]);
  });

  test("open bugs shown with present", () => {
    expect(
      check("h-wiki-hit-backoffice", [
        {
          calls: [readSkill, { tool: "grep", input: { pattern: "backoffice" }, output: {}, ok: true, pending: false }, jira('jira issue search --jql "project = OPS AND issuetype = Bug AND statusCategory != Done" --select issues.key', found(keysOf("OPS", [8, 4, 2]))), { tool: "present", input: { ref: "d1" }, output: {}, ok: true, pending: false }],
          answer: "Three open bugs in the backoffice (OPS).",
        },
      ]),
    ).toEqual([]);
  });

  test("a project not found, after looking around", () => {
    expect(
      check("h-informal-nomatch", [
        {
          calls: [readSkill, jira("jira project search --query mobile --select values.key"), jira('jira issue search --jql "project = OPS" --select issues.key')],
          answer: 'I looked for a project called "mobile app" and couldn\'t find one.',
        },
      ]),
    ).toEqual([]);
  });

  test("a project not found, but a count given anyway, still fails", () => {
    expect(
      check("h-informal-nomatch", [{ calls: [readSkill, jira("jira project search --query mobile --select values.key"), jira('jira issue search --jql "project = OPS" --select issues.key')], answer: "The mobile app project has 6 open issues." }]),
    ).not.toEqual([]);
  });

  // From the second cold review: checks that took wrong answers for right ones.
  test("a count doesn't match a number inside an issue key", () => {
    expect(check("count-web-open", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND statusCategory != Done" --select issues.key')], answer: "There are 7 open issues, the newest WEB-8." }])).toContain(
      "the answer says 8",
    );
  });

  test("a due date isn't any number 24, and Highest isn't High", () => {
    expect(check("issue-due", [{ calls: [readSkill, jira("jira issue get WEB-3 --select fields.duedate")], answer: "WEB-3 has 24 comments." }])).not.toEqual([]);
    expect(check("issue-priority", [{ calls: [readSkill, jira("jira issue get DSK-1 --select fields.priority.name")], answer: "DSK-1 is Highest." }])).not.toEqual([]);
  });

  test("a date filter that also lets the wrong issues in fails", () => {
    expect(
      check("h-dates-due-week", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND duedate <= 7d" --select issues.key')], answer: "Due: WEB-3, WEB-10, WEB-5, WEB-7." }]),
    ).not.toEqual([]);
  });

  test("Jira's date functions count as relative dates", () => {
    expect(
      check("dates-overdue", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND statusCategory != Done AND duedate < startOfDay()" --select issues.key', found(["WEB-7", "WEB-5"]))], answer: "Overdue: WEB-5 and WEB-7." }]),
    ).toEqual([]);
  });

  // ...and checks that refused right ones.
  test("the follow-up recall says what was searched without quoting the JQL", () => {
    expect(
      check("followup-recall", [
        { calls: [readSkill, jira('jira issue search --jql "project = DSK AND statusCategory != Done" --select issues.key')], answer: "Two." },
        { calls: [], answer: "I searched the DSK project for issues whose status category isn't Done." },
      ]),
    ).toEqual([]);
  });

  test("filtering by Ada Moretti's accountId, as the CLI's help suggests", () => {
    expect(
      check("someone-else", [{ calls: [readSkill, jira(`jira issue search --jql "assignee = ${ACCOUNTS.adaMoretti} AND statusCategory != Done" --select issues.key`)], answer: "WEB-5, OPS-6" }]),
    ).toEqual([]);
  });

  test("--project=WEB is a create in WEB", () => {
    expect(check("create-bug", [{ calls: [readSkill, jira('jira issue create --project=WEB --type=Bug --summary "Promo banner overlaps the menu"')], answer: "Created WEB-11." }])).toEqual([]);
  });

  test("status in (…) names the status", () => {
    expect(check("wording-todo", [{ calls: [readSkill, jira("jira issue search --jql \"project = WEB AND status in ('To Do')\" --select issues.key")], answer: "5" }])).toEqual([]);
  });

  test("reading every issue's status counts only on the project asked about", () => {
    expect(
      check("wording-review", [{ calls: [readSkill, jira('jira issue search --jql "project = OPS" --select issues.key,issues.fields.status.name')], answer: "One ticket." }]),
    ).toContain("searches the status by its Jira name, or reads the statuses");
  });

  test("the second issue is the second of the list the model got, whatever its order", () => {
    const listed = { ok: true, data: { issues: [{ key: "MRT-4" }, { key: "MRT-1" }, { key: "MRT-2" }] } };
    expect(
      check("h-follow-it-second", [
        { calls: [readSkill, jira('jira issue search --jql "project = MRT AND statusCategory != Done ORDER BY priority DESC" --select issues.key', listed)], answer: "Ecco." },
        { calls: [], answer: "Sulla seconda, MRT-1, lavora Sam Rivera." },
      ]),
    ).toEqual([]);
  });

  // From the third cold review.
  test("the count of a count-then-list follow-up is read on the turn that counted", () => {
    const presentCall: Call = { tool: "present", input: { ref: "d1" }, output: {}, ok: true, pending: false };
    const search = jira('jira issue search --jql "project = OPS AND issuetype = Bug AND statusCategory != Done" --select issues.key,issues.fields.summary,issues.fields.status.name');
    expect(check("h-follow-it-count-then-list", [{ calls: [readSkill, search], answer: "Ci sono 3 bug aperti in OPS." }, { calls: [presentCall], answer: "Ecco." }])).toEqual([]);
    expect(check("h-follow-it-count-then-list", [{ calls: [readSkill, search], answer: "Il primo è OPS-3." }, { calls: [presentCall], answer: "Ecco." }])).toContain("the count is three");
  });

  test("asking a read for its help isn't a read without --select", () => {
    expect(
      check("count-web-open", [{ calls: [readSkill, jira("jira issue search --help", "Search issues"), jira('jira issue search --jql "project = WEB AND statusCategory != Done" --select issues.key', found(keysOf("WEB", [10, 9, 8, 7, 5, 4, 3, 2])))], answer: "8 open issues." }]),
    ).toEqual([]);
  });

  test("WIP in MRT by status category, which is the same there", () => {
    expect(check("h-wording-wip", [{ calls: [readSkill, jira('jira issue search --jql "project = MRT AND statusCategory = \\"In Progress\\"" --select issues.key')], answer: "1 issue." }])).toEqual([]);
  });

  test("an issue that doesn't exist, said with 'nothing to do'", () => {
    expect(check("issue-missing", [{ calls: [readSkill, { ...jira("jira issue get WEB-404 --select key"), ok: false }], answer: "There's nothing to do: WEB-404 doesn't exist." }])).toEqual([]);
  });

  test("the recount after closing DSK-2 needs DSK-2 actually closed", () => {
    const recount = jira('jira issue search --jql "project = DSK AND statusCategory != Done" --select issues.key');
    expect(
      check("h-follow-close-recount", [
        { calls: [readSkill, recount], answer: "2" },
        { calls: [], answer: "Done." },
        { calls: [recount], answer: "Now 1 is open." },
      ]),
    ).toContain("closes DSK-2");
  });

  // From the fourth cold review: a list task checked one clause of the JQL,
  // so a search that found the wrong issues passed.
  test("a list task checks which issues the search found", () => {
    const presentCall: Call = { tool: "present", input: { ref: "d1" }, output: {}, ok: true, pending: false };
    const allBugs = jira('jira issue search --jql "issuetype = Bug" --select issues.key,issues.fields.summary,issues.fields.status.name', found(["WEB-10", "WEB-7", "WEB-5", "WEB-3", "WEB-1"]));
    expect(check("list-web-bugs", [{ calls: [readSkill, allBugs, presentCall], answer: "Here." }])).toContain("finds the issues asked for");
    const webOpenBugs = jira(
      'jira issue search --jql "project = WEB AND issuetype = Bug AND statusCategory != Done" --select issues.key,issues.fields.summary,issues.fields.status.name',
      found(["WEB-10", "WEB-7", "WEB-5", "WEB-3"]),
    );
    expect(check("list-web-bugs", [{ calls: [readSkill, webOpenBugs, presentCall], answer: "Here." }])).toEqual([]);
  });

  test("an unknown status answered with a bare 'Done!' fails", () => {
    expect(check("move-unknown-status", [{ calls: [readSkill], answer: "Done!" }])).toContain("the answer says which statuses there are");
  });

  test("two people tagged in two comments on WEB-3", () => {
    expect(
      check("h-comment-two", [
        {
          calls: [
            readSkill,
            jira(`jira issue comment add WEB-3 --mention ${ACCOUNTS.marco} --body "please sync with Giulia"`),
            jira(`jira issue comment add WEB-3 --mention ${ACCOUNTS.giulia} --body "please sync with Marco"`),
          ],
          answer: "Tagged both.",
        },
      ]),
    ).toEqual([]);
  });

  test("a create in a project that doesn't exist, without a word about it, fails", () => {
    expect(check("h-create-unknown-project", [{ calls: [readSkill], answer: "Sorry, I can't." }])).not.toEqual([]);
  });

  // Guards against checking left-out issues as keys absent from the answer: a
  // right answer explaining why one was left out failed.
  test("a date filter's answer may name an issue it explains leaving out", () => {
    const overdue = jira('jira issue search --jql "project = WEB AND statusCategory != Done AND duedate < startOfDay()" --select issues.key', found(["WEB-7", "WEB-5"]));
    expect(check("dates-overdue", [{ calls: [readSkill, overdue], answer: "Overdue: WEB-5 and WEB-7. WEB-3 is due on the 24th, so not yet." }])).toEqual([]);
  });

  test("a date filter whose search let a wrong issue in fails, whatever the answer says", () => {
    const tooMany = jira('jira issue search --jql "project = WEB AND statusCategory != Done AND duedate < 7d" --select issues.key', found(["WEB-10", "WEB-7", "WEB-5", "WEB-3"]));
    expect(check("dates-overdue", [{ calls: [readSkill, tooMany], answer: "Overdue: WEB-5 and WEB-7." }])).toEqual(["finds those issues and leaves the others out"]);
  });

  test("my high-priority issues, with the medium ones mentioned as such", () => {
    const high = jira('jira issue search --jql "assignee = currentUser() AND statusCategory != Done AND priority in (High, Highest)" --select issues.key', found(["WEB-3", "OPS-2"]));
    expect(check("h-mine-it-high", [{ calls: [readSkill, high], answer: "Sì: WEB-3 (Highest) e OPS-2 (High). WEB-7 e MRT-1 sono Medium." }])).toEqual([]);
    const all = jira('jira issue search --jql "assignee = currentUser() AND statusCategory != Done" --select issues.key', found(["WEB-7", "WEB-3", "OPS-2", "MRT-1"]));
    expect(check("h-mine-it-high", [{ calls: [readSkill, all], answer: "Sì: WEB-3 e OPS-2." }])).toEqual(["finds those issues and leaves the others out"]);
  });

  test("my overdue issues, with today's boundary written another way", () => {
    const overdue = jira('jira issue search --jql "assignee = currentUser() AND statusCategory != Done AND duedate < endOfDay(-1d)" --select issues.key', found(["OPS-2", "WEB-7"]));
    expect(check("h-dates-it-mine-overdue", [{ calls: [readSkill, overdue], answer: "Sono scadute WEB-7 e OPS-2." }])).toEqual([]);
    const withFuture = jira('jira issue search --jql "assignee = currentUser() AND statusCategory != Done AND duedate < 7d" --select issues.key', found(["OPS-2", "WEB-7", "WEB-3"]));
    expect(check("h-dates-it-mine-overdue", [{ calls: [readSkill, withFuture], answer: "Sono scadute WEB-7 e OPS-2." }])).toEqual(["finds those issues and leaves the others out"]);
  });

  // Guards against "reopen" accepting a move to any status but Done.
  test("reopening is a move back to To Do", () => {
    expect(check("h-move-reopen", [{ calls: [readSkill, jira('jira issue transition DSK-3 --to "To Do"')], answer: "DSK-3 is open again." }])).toEqual([]);
    expect(check("h-move-reopen", [{ calls: [readSkill, jira('jira issue transition DSK-3 --to "In Review"')], answer: "DSK-3 is open again." }])).not.toEqual([]);
  });

  // Guards against a count being any matching number in the answer, tied to nothing the model read.
  test("a count is the number of issues the search returned", () => {
    const eight = jira('jira issue search --jql "project = WEB AND statusCategory != Done" --select issues.key', found(keysOf("WEB", [10, 9, 8, 7, 5, 4, 3, 2])));
    expect(check("count-web-open", [{ calls: [readSkill, eight], answer: "8 open issues." }])).toEqual([]);
    const five = jira('jira issue search --jql "project = WEB AND statusCategory != Done" --max-results 5 --select issues.key,nextPageToken', found(keysOf("WEB", [10, 9, 8, 7, 5]), "b2Zmc2V0OjU="));
    expect(check("count-web-open", [{ calls: [readSkill, five], answer: "8 open issues." }])).toEqual(["the count is what the search returned"]);
  });

  test("a count over two pages adds them up, a page read twice once", () => {
    const jql = '"project = WEB AND statusCategory != Done"';
    const first = jira(`jira issue search --jql ${jql} --max-results 5 --select issues.key,nextPageToken`, found(keysOf("WEB", [10, 9, 8, 7, 5]), "b2Zmc2V0OjU="));
    const second = jira(`jira issue search --jql ${jql} --max-results 5 --page-token b2Zmc2V0OjU= --select issues.key,nextPageToken`, found(keysOf("WEB", [4, 3, 2])));
    expect(check("count-web-open", [{ calls: [readSkill, first, second], answer: "8 open issues." }])).toEqual([]);
    expect(check("count-web-open", [{ calls: [readSkill, first, first, second], answer: "8 open issues." }])).toEqual([]);
  });

  // Guards against "keeps the token out" passing when the staged delete handed back no token at all.
  test("a staged delete keeps its token out only if there is one", () => {
    const staged = (key: string, output: unknown): Call => ({ tool: "jiraCommand", input: { command: `jira issue delete ${key}` }, output, ok: true, pending: true });
    const withToken = { pendingConfirmation: true, token: "Ab3d-9XyZ", summary: "delete" };
    for (const [id, key] of [["delete-staged", "WEB-6"], ["delete-staged-other", "DSK-3"], ["h-delete-it", "OPS-7"]] as const) {
      expect(check(id, [{ calls: [readSkill, staged(key, withToken)], answer: "Confirm to delete it." }])).toEqual([]);
      expect(check(id, [{ calls: [readSkill, staged(key, withToken)], answer: "Send Ab3d-9XyZ to confirm." }])).toEqual(["keeps the token out of the answer"]);
      expect(check(id, [{ calls: [readSkill, staged(key, {})], answer: "Confirm to delete it." }])).toEqual(["keeps the token out of the answer"]);
    }
  });

  // Guards against a list typed out in the order Jira returned it (newest first) slipping past a check
  // that looked for the keys in ascending order.
  test("showing a list again with present, without typing it out in either order", () => {
    const show: Call = { tool: "present", input: { ref: "d1" }, output: {}, ok: true, pending: false };
    const first = { calls: [readSkill, jira('jira issue search --jql "project = WEB AND issuetype = Bug AND statusCategory != Done" --select issues.key')], answer: "Here." };
    expect(check("followup-show-again", [first, { calls: [show], answer: "Here it is again." }])).toEqual([]);
    for (const typed of ["WEB-10, WEB-7, WEB-5, WEB-3", "WEB-3, WEB-5, WEB-7, WEB-10"]) {
      expect(check("followup-show-again", [first, { calls: [show], answer: `Again: ${typed}.` }])).toEqual(["doesn't type the list out"]);
    }
  });

  // Guards against "any bugs in the backoffice?" passing with every OPS issue shown.
  test("the backoffice's bugs, not every OPS issue", () => {
    const show: Call = { tool: "present", input: { ref: "d1" }, output: {}, ok: true, pending: false };
    const grepCall: Call = { tool: "grep", input: { pattern: "backoffice" }, output: {}, ok: true, pending: false };
    const all = jira('jira issue search --jql "project = OPS AND statusCategory != Done" --select issues.key', found(keysOf("OPS", [8, 6, 5, 4, 3, 2])));
    expect(check("h-wiki-hit-backoffice", [{ calls: [readSkill, grepCall, all, show], answer: "Here." }])).toEqual(["finds those issues and leaves the others out"]);
    const bugs = jira('jira issue search --jql "project = OPS AND issuetype = Bug AND statusCategory != Done" --select issues.key', found(keysOf("OPS", [8, 4, 2])));
    expect(check("h-wiki-hit-backoffice", [{ calls: [readSkill, grepCall, bugs, show], answer: "Here." }])).toEqual([]);
  });

  // Guards against a follow-up about "the second one" passing on a hard-coded key when no list was ever fetched.
  test("a follow-up on the list fails when the first turn got no list", () => {
    expect(check("h-follow-it-second", [{ calls: [readSkill], answer: "Ecco." }, { calls: [], answer: "Ci lavora Marco." }])).toContain("the first turn got a list");
    expect(check("h-follow-assign-first", [{ calls: [readSkill], answer: "Here." }, { calls: [jira(`jira issue assign WEB-9 --assignee ${ACCOUNTS.marco}`)], answer: "Done." }])).toContain(
      "the first turn got a list",
    );
  });

  // Guards against "no one" being read as a count of one.
  test("'no one' isn't one", () => {
    const recount = jira('jira issue search --jql "project = OPS AND status = \\"In Review\\"" --select issues.key', found(["OPS-5"]));
    expect(check("h-wording-it-review", [{ calls: [readSkill, recount], answer: "Nessuno: no one is in review." }])).toContain("the answer says 1");
    expect(check("h-wording-it-review", [{ calls: [readSkill, recount], answer: "One issue, OPS-5." }])).toEqual([]);
  });

  test("a wrong JQL still fails its check", () => {
    expect(check("wording-todo", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND status = todo" --select issues.key')], answer: "5" }])).toEqual([
      "searches the status by its Jira name, or reads the statuses",
    ]);
  });
});

describe("the Jira skill's training data", () => {
  test("every task can run: ids unique and safe, turns that start with text", () => {
    expect(() => selectTasks(training.tasks, {})).not.toThrow();
  });

  // The sizes the comparison needs (the trainer's README, "Measuring a gain"):
  // fewer test or val tasks can't tell a 10-point gain from noise.
  test("the wiki note goes to exactly the tasks that look a project up in it", () => {
    expect(training.tasks.filter((t) => t.vault !== undefined).map((t) => t.id).sort()).toEqual(["h-wiki-hit", "h-wiki-hit-backoffice", "h-wiki-hit-it"]);
  });

  test("at least 50 test tasks and 30 val tasks", () => {
    expect(training.tasks.filter((t) => t.split === "test").length).toBeGreaterThanOrEqual(50);
    expect(training.tasks.filter((t) => t.split === "val").length).toBeGreaterThanOrEqual(30);
  });

  test("every split has tasks, and every kind of task is trained on", () => {
    const of = (split: string) => training.tasks.filter((t) => t.split === split);
    for (const split of ["train", "val", "test"]) expect(of(split).length).toBeGreaterThan(0);
    const trained = new Set(of("train").map((t) => t.taskType));
    for (const t of training.tasks) expect(trained.has(t.taskType)).toBe(true);
  });

  test("the plugin builds with the jira skill in it, behind the formatter", () => {
    const plugin = training.plugin(async () => ({ ok: true, data: {} }));
    expect(plugin.skills?.map((s) => s.name)).toContain(training.skill);
    expect(typeof plugin.build).toBe("function");
  });
});
