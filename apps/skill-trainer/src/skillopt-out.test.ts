import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrainingTask } from "./contract.ts";
import type { TaskResult } from "./harness.ts";
import { conversationOf, rolloutOf, skillOptItems, writeSkillOptRollout } from "./skillopt-out.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-trainer-skillopt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const passed: TaskResult = {
  id: "count-web",
  split: "train",
  taskType: "count",
  hard: 1,
  soft: 1,
  checks: [
    { label: "loads the jira skill", ok: true },
    { label: "the answer says 8", ok: true },
  ],
  turns: [
    {
      sent: "How many open issues in WEB?",
      calls: [{ tool: "jiraCommand", input: { command: "jira issue search --jql 'project = WEB'" }, output: { ok: true, data: { issues: [{ key: "WEB-1" }] } }, ok: true, pending: false }],
      answer: "There are 8.",
      seconds: 3,
    },
  ],
  unmatched: [],
  seconds: 3,
};

const failed: TaskResult = {
  ...passed,
  id: "follow-up",
  taskType: "follow-up",
  hard: 0,
  soft: 0.5,
  checks: [
    { label: "searches again", ok: true },
    { label: "the answer says 1", ok: false, detail: 'answer: "Two are open."' },
  ],
  turns: [
    { sent: "How many open in DSK?", calls: [], answer: "2", seconds: 1 },
    { sent: "And now?", calls: [], answer: "Two are open.", seconds: 1 },
  ],
  unmatched: [["jira", "issue", "frobnicate"]],
};

describe("conversationOf", () => {
  test("each turn as the user's message, the tool calls with their output, the answer; the checks last", () => {
    expect(conversationOf(passed)).toEqual([
      { role: "user", content: "How many open issues in WEB?" },
      { type: "tool_call", cmd: `jiraCommand {"command":"jira issue search --jql 'project = WEB'"}`, obs: '{"ok":true,"data":{"issues":[{"key":"WEB-1"}]}}' },
      { role: "assistant", content: "There are 8." },
      { role: "system", content: "checks:\n[pass] loads the jira skill\n[pass] the answer says 8" },
    ]);
  });

  test("a failed check carries its detail, and the commands no fixture answered are listed", () => {
    expect(conversationOf(failed).at(-1)).toEqual({
      role: "system",
      content: 'checks:\n[pass] searches again\n[FAIL] the answer says 1 (answer: "Two are open.")\ncommands the fake service didn\'t know: jira issue frobnicate',
    });
  });

  test("a tool output too long for the analyst is cut, saying how much was left out", () => {
    const long: TaskResult = { ...passed, turns: [{ ...passed.turns[0]!, calls: [{ ...passed.turns[0]!.calls[0]!, output: "x".repeat(5000) }] }] };
    const obs = (conversationOf(long)[1] as { obs: string }).obs;
    expect(obs).toHaveLength(4000 + "… [1002 more characters]".length);
    expect(obs.endsWith("… [1002 more characters]")).toBe(true);
  });

  test("a task that stopped before its checks says why", () => {
    expect(conversationOf({ ...failed, error: "model unreachable" }).at(-1)).toEqual({ role: "system", content: "the task couldn't run: model unreachable" });
  });
});

describe("rolloutOf", () => {
  test("what SkillOpt reads of a result: id, scores, type, the request, why it failed, the answer", () => {
    expect(rolloutOf(failed)).toEqual({
      id: "follow-up",
      hard: 0,
      soft: 0.5,
      task_type: "follow-up",
      task_description: "turn 1: How many open in DSK?\nturn 2: And now?",
      fail_reason: "the answer says 1",
      predicted_answer: "Two are open.",
      n_turns: 2,
    });
  });

  test("a passed task has no fail reason, a task that couldn't run has its error", () => {
    expect(rolloutOf(passed).fail_reason).toBe("");
    expect(rolloutOf({ ...failed, error: "stalled", turns: [] })).toMatchObject({ fail_reason: "stalled", task_description: "", predicted_answer: "", n_turns: 0 });
  });
});

describe("writeSkillOptRollout", () => {
  test("a conversation file per task under predictions/, and the results in results.json", async () => {
    await writeSkillOptRollout(dir, [passed, failed]);
    expect(JSON.parse(readFileSync(join(dir, "predictions", "count-web", "conversation.json"), "utf8"))).toEqual(conversationOf(passed));
    expect(JSON.parse(readFileSync(join(dir, "predictions", "follow-up", "conversation.json"), "utf8"))).toEqual(conversationOf(failed));
    expect(JSON.parse(readFileSync(join(dir, "results.json"), "utf8"))).toEqual([rolloutOf(passed), rolloutOf(failed)]);
  });
});

describe("skillOptItems", () => {
  const task = (id: string, split: TrainingTask["split"], turns: TrainingTask["turns"]): TrainingTask => ({ id, split, taskType: "t", turns, check: () => {} });

  test("the tasks as SkillOpt's split items: id, type and the first turn as the question", () => {
    const tasks = [task("a", "train", ["first", (prev) => prev.answer]), task("b", "val", ["second"]), task("c", "test", ["third"]), task("d", "train", ["fourth"])];
    expect(skillOptItems(tasks)).toEqual({
      train: [
        { id: "a", task_type: "t", question: "first" },
        { id: "d", task_type: "t", question: "fourth" },
      ],
      val: [{ id: "b", task_type: "t", question: "second" }],
      test: [{ id: "c", task_type: "t", question: "third" }],
    });
  });
});
