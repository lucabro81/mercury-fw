import { describe, expect, test } from "bun:test";
import type { StepInfo } from "../session/step-info.ts";
import { confirmationId } from "../session/turn-trace.ts";
import { stepEvents } from "./step-events.ts";

/** A step as the AI SDK hands it over at runtime: StepInfo plus what the type doesn't name. */
function runtimeStep(step: Partial<StepInfo> & Record<string, unknown>): StepInfo {
  return { toolCalls: [], toolResults: [], content: [], ...step } as StepInfo;
}

describe("stepEvents", () => {
  test("a model step carries what Ollama measured: tokens, and load / prefill / generation time in ms", () => {
    const step = runtimeStep({
      stepNumber: 0,
      model: { provider: "ollama", modelId: "qwen3.8:27b" },
      finishReason: "stop",
      usage: {
        inputTokens: 5400,
        outputTokens: 120,
        raw: { load_duration: 1_500_000, prompt_eval_duration: 2_800_000_000, eval_duration: 5_250_400_000, total_duration: 8_100_000_000 },
      },
    });
    expect(stepEvents(step)).toEqual([
      {
        kind: "model.step",
        step: 0,
        model: "qwen3.8:27b",
        finishReason: "stop",
        inputTokens: 5400,
        outputTokens: 120,
        loadMs: 2,
        prefillMs: 2800,
        generationMs: 5250,
        totalMs: 8100,
        toolCalls: 0,
      },
    ]);
  });

  test("what the step doesn't carry is left out, not guessed (a test fake, another provider)", () => {
    expect(stepEvents(runtimeStep({}))).toEqual([{ kind: "model.step", toolCalls: 0 }]);
  });

  test("each tool call is an event: its outcome, how long it ran and how big its result was; the input only as args, long strings cut", () => {
    const longBody = "x".repeat(800);
    const output = { ok: true, data: [1, 2, 3] };
    const step = runtimeStep({
      toolCalls: [{ toolCallId: "c1", toolName: "write_file", input: { path: "personal/notes/a.md", content: longBody } }],
      toolResults: [{ toolCallId: "c1", toolName: "write_file", output }],
      performance: { toolExecutionMs: { c1: 41.7 } },
    });
    const [, call] = stepEvents(step);
    expect(call).toEqual({
      kind: "tool.call",
      tool: "write_file",
      outcome: "success",
      durationMs: 42,
      resultChars: JSON.stringify(output).length,
      args: { input: { path: "personal/notes/a.md", content: `${"x".repeat(500)}…` } },
    });
  });

  test("a tool that answered ok:false failed, and its error goes with the args", () => {
    const step = runtimeStep({
      toolCalls: [{ toolCallId: "c1", toolName: "jiraCommand", input: { command: "jira issue list" } }],
      toolResults: [{ toolCallId: "c1", toolName: "jiraCommand", output: { ok: false, error: "exit 1: bad JQL" } }],
    });
    const call = stepEvents(step)[1]!;
    expect(call.outcome).toBe("failed");
    expect(call.args).toEqual({ input: { command: "jira issue list" }, error: "exit 1: bad JQL" });
  });

  test("a call the SDK rejected before running has no result: failed, with the SDK's error", () => {
    const step = runtimeStep({
      toolCalls: [{ toolCallId: "c1", toolName: "jiraCommand", input: { nope: 1 } }],
      content: [{ type: "tool-error", toolCallId: "c1", error: new Error("invalid arguments") }],
    });
    const call = stepEvents(step)[1]!;
    expect(call).toMatchObject({ kind: "tool.call", tool: "jiraCommand", outcome: "failed" });
    expect("resultChars" in call).toBe(false);
    expect(call.args).toEqual({ input: { nope: 1 }, error: "invalid arguments" });
  });

  // A single action to confirm counts as one choice, as the channels show it.
  test("a call staged behind a confirmation is pending, and the step adds the staged confirmation with its id, never the token", () => {
    const output = { ok: false, pendingConfirmation: true, token: "abcd-efgh-ijkl", summary: "Delete issue ABC-1", choices: [] };
    const step = runtimeStep({
      toolCalls: [{ toolCallId: "c1", toolName: "jiraCommand", input: { command: "jira issue delete ABC-1" } }],
      toolResults: [{ toolCallId: "c1", toolName: "jiraCommand", output }],
    });
    const events = stepEvents(step);
    expect(events[1]).toMatchObject({ kind: "tool.call", outcome: "pending" });
    expect(events[2]).toEqual({
      kind: "confirmation.staged",
      confirmationId: confirmationId("abcd-efgh-ijkl"),
      choices: 1,
      args: { summary: "Delete issue ABC-1" },
    });
    expect(JSON.stringify(events)).not.toContain("abcd-efgh-ijkl");
  });
});
