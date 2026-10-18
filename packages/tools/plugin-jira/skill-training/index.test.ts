import { describe, expect, test } from "bun:test";
import { createExpect } from "../../../../apps/cli/src/e2e/expect.ts";
import type { Call, Run } from "../../../../apps/skill-trainer/src/contract.ts";
import { selectTasks } from "../../../../apps/skill-trainer/src/harness.ts";
import training from "./index.ts";
import { ACCOUNTS } from "./world.ts";

/** A jiraCommand call that worked. */
const jira = (command: string, output: unknown = {}): Call => ({ tool: "jiraCommand", input: { command }, output, ok: true, pending: false });
const readSkill: Call = { tool: "read_skill", input: { name: "jira" }, output: {}, ok: true, pending: false };

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
          calls: [readSkill, { tool: "grep", input: { pattern: "backoffice" }, output: {}, ok: true, pending: false }, jira('jira issue search --jql "project = OPS AND issuetype = Bug AND statusCategory != Done" --select issues.key'), { tool: "present", input: { ref: "d1" }, output: {}, ok: true, pending: false }],
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
      check("dates-overdue", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND statusCategory != Done AND duedate < startOfDay()" --select issues.key')], answer: "Overdue: WEB-5 and WEB-7." }]),
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
