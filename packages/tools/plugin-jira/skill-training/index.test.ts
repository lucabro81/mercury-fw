import { describe, expect, test } from "bun:test";
import { selectTasks } from "../../../../apps/skill-trainer/src/harness.ts";
import training from "./index.ts";

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
