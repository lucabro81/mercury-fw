import { describe, expect, test } from "bun:test";
import type { TaskResult } from "./harness.ts";
import { exitCodeFor, formatReport } from "./report.ts";

const result = (over: Partial<TaskResult>): TaskResult => ({
  id: "t1",
  split: "train",
  taskType: "search",
  hard: 1,
  soft: 1,
  checks: [{ label: "a jiraCommand call", ok: true }],
  turns: [],
  unmatched: [],
  seconds: 3.26,
  ...over,
});

describe("formatReport", () => {
  test("every task with its checks, then the scores", () => {
    const lines = formatReport([
      result({}),
      result({
        id: "t2",
        split: "val",
        taskType: "count",
        hard: 0,
        soft: 0.5,
        checks: [
          { label: "a jiraCommand call", ok: true },
          { label: 'answer contains "12"', ok: false, detail: "There are 11 issues." },
        ],
        seconds: 1,
      }),
    ]);
    expect(lines).toEqual([
      "t1 (train, search): passed, 1/1 checks, 3.3s",
      "  ✓ a jiraCommand call",
      "t2 (val, count): FAILED, 1/2 checks, 1.0s",
      "  ✓ a jiraCommand call",
      '  ✗ answer contains "12": There are 11 issues.',
      "",
      "hard 1/2 tasks, soft 0.75",
    ]);
  });

  test("the commands no fixture answered, quoted as typed, and a warning before the scores", () => {
    const lines = formatReport([result({ unmatched: [["issue", "search", "--jql", "project = KAN"], ["sprint", "list"]] })]);
    expect(lines).toEqual([
      "t1 (train, search): passed, 1/1 checks, 3.3s",
      "  ✓ a jiraCommand call",
      '  no fixture for: issue search --jql "project = KAN"',
      "  no fixture for: sprint list",
      "",
      "hard 1/1 tasks, soft 1.00",
      "1 task ran commands no fixture answers: add fixtures for them before trusting these scores",
    ]);
  });

  test("an empty batch says so", () => {
    expect(formatReport([])).toEqual(["no tasks ran"]);
  });
});

describe("exitCodeFor", () => {
  test("0 when every task ran, whatever it scored", () => {
    expect(exitCodeFor([result({}), result({ id: "t2", hard: 0, soft: 0 })])).toBe(0);
  });

  test("1 when a task couldn't run: its score says nothing about the skill", () => {
    expect(exitCodeFor([result({}), result({ id: "t2", hard: 0, soft: 0, error: "the model sent nothing for 120s" })])).toBe(1);
  });

  test("1 when no task ran", () => {
    expect(exitCodeFor([])).toBe(1);
  });
});
