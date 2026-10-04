import { describe, it, expect, beforeEach } from "bun:test";
import { createToolLogRecallTool } from "./tool-log-recall-tool.ts";
import { recordStep, resetToolLogForTest } from "./tool-log-buffer.ts";
import type { StepInfo } from "./step-info.ts";

function stepWithOneCall(toolName: string, input: unknown, output: unknown): StepInfo {
  return {
    toolCalls: [{ toolCallId: "call-1", toolName, input }],
    toolResults: [{ toolCallId: "call-1", toolName, output }],
    content: [],
  };
}

describe("createToolLogRecallTool", () => {
  beforeEach(() => {
    resetToolLogForTest();
  });

  it("only returns entries recorded under the same sessionKey", async () => {
    recordStep("google-chat", "space-A:user-1", "static:alice", stepWithOneCall("runCommand", { command: "jira issue search" }, { ok: true }));
    recordStep("google-chat", "space-B:user-2", "static:alice", stepWithOneCall("runCommand", { command: "other space's call" }, { ok: true }));

    const { recall_tool_calls } = createToolLogRecallTool({ sessionKey: "space-A:user-1", owner: "static:alice" });
    const result = (await recall_tool_calls.execute!({}, {} as never)) as { ok: true; entries: unknown[] };

    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
  });

  it("respects a custom limit", async () => {
    for (let i = 0; i < 5; i++) {
      recordStep("terminal", "terminal", "static:alice", stepWithOneCall(`tool-${i}`, {}, { ok: true }));
    }

    const { recall_tool_calls } = createToolLogRecallTool({ sessionKey: "terminal", owner: "static:alice" });
    const result = (await recall_tool_calls.execute!({ limit: 2 }, {} as never)) as { ok: true; entries: unknown[] };

    expect(result.entries).toHaveLength(2);
  });

  it("defaults to a reasonable limit when none is given", async () => {
    for (let i = 0; i < 20; i++) {
      recordStep("terminal", "terminal", "static:alice", stepWithOneCall(`tool-${i}`, {}, { ok: true }));
    }

    const { recall_tool_calls } = createToolLogRecallTool({ sessionKey: "terminal", owner: "static:alice" });
    const result = (await recall_tool_calls.execute!({}, {} as never)) as { ok: true; entries: unknown[] };

    expect(result.entries.length).toBeLessThanOrEqual(10);
  });

  it("returns entries with the tool name, input, and output visible", async () => {
    recordStep("google-chat", "space-A:user-1", "static:alice",
      stepWithOneCall("runCommand", { command: 'jira issue search --jql "assignee=x"' }, { ok: true, data: {} }),
    );

    const { recall_tool_calls } = createToolLogRecallTool({ sessionKey: "space-A:user-1", owner: "static:alice" });
    const result = (await recall_tool_calls.execute!({}, {} as never)) as {
      ok: true;
      entries: Array<{ toolName: string; input: string; output: string }>;
    };

    expect(result.entries[0]?.toolName).toBe("runCommand");
    expect(result.entries[0]?.input).toContain("jira issue search");
  });

  it("never returns someone else's calls, even on a session key they share", async () => {
    recordStep("http", "shared", "static:bob", stepWithOneCall("runCommand", { command: "bob's" }, { ok: true }));
    recordStep("http", "shared", "static:alice", stepWithOneCall("runCommand", { command: "alice's" }, { ok: true }));

    const { recall_tool_calls } = createToolLogRecallTool({ sessionKey: "shared", owner: "static:alice" });
    const result = (await recall_tool_calls.execute!({}, {} as never)) as { ok: true; entries: { input: string }[] };

    expect(result.entries.map((e) => e.input)).toEqual([JSON.stringify({ command: "alice's" })]);
  });
});
