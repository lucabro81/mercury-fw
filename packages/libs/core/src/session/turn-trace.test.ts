import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import type { TurnSink } from "@mercury-fw/channel-types";
import { confirmationId, createTurnTrace } from "./turn-trace.ts";
import type { StepInfo } from "./step-info.ts";

/** A sink that records every call it gets, with every optional member set. */
function recordingSink(): { sink: TurnSink; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const sink: TurnSink = {
    onToolStart: (...args) => calls.push(["toolStart", ...args]),
    onToolFinish: (...args) => calls.push(["toolFinish", ...args]),
    onTextChunk: (...args) => calls.push(["text", ...args]),
    onReasoningChunk: (...args) => calls.push(["reasoning", ...args]),
    onReasoningEnd: (...args) => calls.push(["reasoningEnd", ...args]),
    onStep: (...args) => calls.push(["step", ...args]),
    onUsage: (...args) => calls.push(["usage", ...args]),
    finalize: async (...args) => {
      calls.push(["finalize", ...args]);
    },
    dispose: () => calls.push(["dispose"]),
  };
  return { sink, calls };
}

/** A sink with only the required members, like Google Chat's answer delivery. */
function bareSink(): TurnSink {
  return { onToolStart: () => {}, finalize: async () => {}, dispose: () => {} };
}

function stepWithResult(output: unknown): StepInfo {
  return {
    toolCalls: [{ toolCallId: "c1", toolName: "web_fetch", input: {} }],
    toolResults: [{ toolCallId: "c1", toolName: "web_fetch", output }],
    content: [],
  };
}

describe("confirmationId", () => {
  it("is the first 16 hex characters of the token's SHA-256, never the token itself", () => {
    const expected = createHash("sha256").update("k9m2-x7q4").digest("hex").slice(0, 16);
    expect(confirmationId("k9m2-x7q4")).toBe(expected);
    expect(confirmationId("k9m2-x7q4")).not.toContain("k9m2");
    expect(confirmationId("k9m2-x7q5")).not.toBe(expected);
  });
});

describe("createTurnTrace", () => {
  it("forwards every call to the sink unchanged", async () => {
    const { sink, calls } = recordingSink();
    const trace = createTurnTrace(sink);
    const step = stepWithResult({ ok: true });

    trace.sink.onToolStart("Reading", "KAN-1", "c1", "jiraCommand");
    trace.sink.onToolFinish?.("c1", "success");
    trace.sink.onTextChunk?.("Hi");
    trace.sink.onReasoningChunk?.("hm", "r1");
    trace.sink.onReasoningEnd?.("r1", false);
    trace.sink.onStep?.(step);
    trace.sink.onUsage?.(12);
    await trace.sink.finalize("Hi", { pendingNote: "note" });
    trace.sink.dispose();

    expect(calls).toEqual([
      ["toolStart", "Reading", "KAN-1", "c1", "jiraCommand"],
      ["toolFinish", "c1", "success"],
      ["text", "Hi"],
      ["reasoning", "hm", "r1"],
      ["reasoningEnd", "r1", false],
      ["step", step],
      ["usage", 12],
      ["finalize", "Hi", { pendingNote: "note" }],
      ["dispose"],
    ]);
  });

  // The streaming callbacks decide the turn's path (`streamText` or not): a
  // trace must never turn on streaming for a channel that didn't ask for it,
  // nor claim a callback the channel doesn't have.
  it("leaves the optional callbacks absent when the sink has none", () => {
    const trace = createTurnTrace(bareSink());

    expect(trace.sink.onTextChunk).toBeUndefined();
    expect(trace.sink.onReasoningChunk).toBeUndefined();
    expect(trace.sink.onReasoningEnd).toBeUndefined();
    expect(trace.sink.onToolFinish).toBeUndefined();
  });

  it("records nothing for a turn that only wrote text", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onTextChunk?.("Hello");

    expect(trace.entries()).toEqual([]);
  });

  it("joins each reasoning block's chunks, in the order the blocks started", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onReasoningChunk?.("first ", "r1");
    trace.sink.onReasoningChunk?.("second ", "r2");
    trace.sink.onReasoningChunk?.("thought", "r1");
    trace.sink.onReasoningEnd?.("r1", false);
    trace.sink.onReasoningChunk?.("thought", "r2");
    trace.sink.onReasoningEnd?.("r2", false);

    expect(trace.entries()).toEqual([
      { type: "reasoning", text: "first thought" },
      { type: "reasoning", text: "second thought" },
    ]);
  });

  it("marks a reasoning block that ended failed", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onReasoningChunk?.("cut", "r1");
    trace.sink.onReasoningEnd?.("r1", true);

    expect(trace.entries()).toEqual([{ type: "reasoning", text: "cut", failed: true }]);
  });

  it("interleaves reasoning and tools in the order they happened", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onReasoningChunk?.("look it up", "r1");
    trace.sink.onReasoningEnd?.("r1", false);
    trace.sink.onToolStart("Reading KAN-1", "issue view KAN-1", "c1", "jiraCommand");
    trace.sink.onToolFinish?.("c1", "success");
    trace.sink.onReasoningChunk?.("got it", "r2");
    trace.sink.onReasoningEnd?.("r2", false);

    expect(trace.entries()).toEqual([
      { type: "reasoning", text: "look it up" },
      { type: "tool", label: "Reading KAN-1", detail: "issue view KAN-1", name: "jiraCommand", outcome: "success" },
      { type: "reasoning", text: "got it" },
    ]);
  });

  it("pairs each tool's outcome by its call id", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onToolStart("A", undefined, "c1", "a");
    trace.sink.onToolStart("B", undefined, "c2", "b");
    trace.sink.onToolFinish?.("c2", "failed");
    trace.sink.onToolFinish?.("c1", "pending");

    expect(trace.entries()).toEqual([
      { type: "tool", label: "A", name: "a", outcome: "pending" },
      { type: "tool", label: "B", name: "b", outcome: "failed" },
    ]);
  });

  it("keeps a tool that never finished without an outcome, and ignores a finish for an unknown id", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onToolStart("Still running", "detail", "c1", "slow");
    trace.sink.onToolFinish?.("nope", "success");

    expect(trace.entries()).toEqual([{ type: "tool", label: "Still running", detail: "detail", name: "slow" }]);
  });

  it("records a status line with no call id or tool name (a guard, a capture ping)", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onToolStart("Checking the answer", undefined, "guard:lists");
    trace.sink.onToolFinish?.("guard:lists", "success");
    trace.sink.onToolStart("Saving to memory");

    expect(trace.entries()).toEqual([
      { type: "tool", label: "Checking the answer", outcome: "success" },
      { type: "tool", label: "Saving to memory" },
    ]);
  });

  it("records a staged confirmation by its id, with its command and choice labels, and no token", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onStep?.(
      stepWithResult({
        ok: false,
        pendingConfirmation: true,
        token: "TOK1-aaaa",
        summary: "https://example.org/a",
        choices: [
          { token: "TOK1-aaaa", label: "Only this time" },
          { token: "TOK2-bbbb", label: "Always for example.org" },
        ],
      }),
    );

    const entries = trace.entries();
    expect(entries).toEqual([
      {
        type: "confirmation",
        id: confirmationId("TOK1-aaaa"),
        command: "https://example.org/a",
        choices: ["Only this time", "Always for example.org"],
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("TOK");
  });

  it("records a plain staging with one empty choice label", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onStep?.(stepWithResult({ ok: false, pendingConfirmation: true, token: "TOK1-aaaa", summary: "delete KAN-1" }));

    expect(trace.entries()).toEqual([{ type: "confirmation", id: confirmationId("TOK1-aaaa"), command: "delete KAN-1", choices: [""] }]);
  });

  it("records each login a step asked for by its service, never its link", () => {
    const trace = createTurnTrace(recordingSink().sink);
    const step: StepInfo = {
      toolCalls: [
        { toolCallId: "c1", toolName: "jiraCommand", input: {} },
        { toolCallId: "c2", toolName: "confluenceCommand", input: {} },
      ],
      toolResults: [
        { toolCallId: "c1", toolName: "jiraCommand", output: { loginRequired: true, service: "jira", authorizeUrl: "https://auth/x?state=s1" } },
        { toolCallId: "c2", toolName: "confluenceCommand", output: { loginRequired: true, service: "confluence", authorizeUrl: "https://auth/y?state=s2" } },
      ],
      content: [],
    };

    trace.sink.onStep?.(step);

    const entries = trace.entries();
    expect(entries).toEqual([
      { type: "login", service: "jira" },
      { type: "login", service: "confluence" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("https://");
  });

  it("records nothing for a step with neither a staging nor a login", () => {
    const trace = createTurnTrace(recordingSink().sink);

    trace.sink.onStep?.(stepWithResult({ ok: true, data: [] }));

    expect(trace.entries()).toEqual([]);
  });

  it("records the step even when the sink has no onStep of its own", () => {
    const trace = createTurnTrace(bareSink());

    trace.sink.onStep?.(stepWithResult({ ok: false, pendingConfirmation: true, token: "TOK1-aaaa", summary: "x" }));

    expect(trace.entries()).toHaveLength(1);
  });

  it("hands out a copy: later calls don't change entries already taken", () => {
    const trace = createTurnTrace(recordingSink().sink);
    trace.sink.onReasoningChunk?.("a", "r1");
    const before = trace.entries();

    trace.sink.onReasoningChunk?.("b", "r1");
    trace.sink.onToolStart("T", undefined, "c1");

    expect(before).toEqual([{ type: "reasoning", text: "a" }]);
    expect(trace.entries()).toEqual([
      { type: "reasoning", text: "ab" },
      { type: "tool", label: "T" },
    ]);
  });
});
