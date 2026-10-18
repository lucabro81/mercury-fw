import { describe, expect, test } from "bun:test";
import { createExpect } from "../../../../apps/cli/src/e2e/expect.ts";
import type { Call, Run } from "../../../../apps/skill-trainer/src/contract.ts";
import { selectTasks } from "../../../../apps/skill-trainer/src/harness.ts";
import training from "./index.ts";

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

  test("a wrong JQL still fails its check", () => {
    expect(check("wording-todo", [{ calls: [readSkill, jira('jira issue search --jql "project = WEB AND status = todo" --select issues.key')], answer: "5" }])).toEqual([
      "searches the status by its Jira name",
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
