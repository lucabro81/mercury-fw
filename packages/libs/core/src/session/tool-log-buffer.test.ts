import { describe, it, expect, beforeEach } from "bun:test";
import { recordStep, getToolLog, resetToolLogForTest } from "./tool-log-buffer.ts";
import type { StepInfo } from "./step-info.ts";

function stepWithOneCall(toolName: string, output: unknown): StepInfo {
  return {
    toolCalls: [{ toolCallId: "call-1", toolName, input: { x: 1 } }],
    toolResults: [{ toolCallId: "call-1", toolName, output }],
    content: [],
  };
}

describe("recordStep / getToolLog", () => {
  beforeEach(() => {
    resetToolLogForTest();
  });

  it("returns only the person's entries from the given session", () => {
    recordStep("google-chat", "space-A:user-1", "static:alice", stepWithOneCall("runCommand", { ok: true }));
    recordStep("google-chat", "space-B:user-2", "static:alice", stepWithOneCall("runCommand", { ok: true }));

    const entries = getToolLog({ owner: "static:alice", sessionKey: "space-A:user-1" });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionKey).toBe("space-A:user-1");
  });

  it("returns only the given person's entries, whatever session they came from", () => {
    recordStep("http", "alice:c1", "static:alice", stepWithOneCall("first", { ok: true }));
    recordStep("http", "bob:c1", "static:bob", stepWithOneCall("bob's", { ok: true }));
    recordStep("http", "alice:c2", "static:alice", stepWithOneCall("second", { ok: true }));

    expect(getToolLog({ owner: "static:alice" }).map((e) => [e.sessionKey, e.toolName])).toEqual([
      ["alice:c2", "second"],
      ["alice:c1", "first"],
    ]);
    expect(getToolLog({ owner: "static:alice" })[0]?.owner).toBe("static:alice");
    expect(getToolLog({ owner: "static:carol" })).toEqual([]);
  });

  // Review of #176: the log is read back by the model (recall_tool_calls), and
  // a login link carries the state the public callback trusts.
  it("never keeps a login link", () => {
    recordStep("http", "s1", "static:alice", stepWithOneCall("jiraCommand", {
      ok: false, loginRequired: true, service: "jira", authorizeUrl: "https://auth?state=secret", error: "log in",
    }));
    const [entry] = getToolLog({ owner: "static:alice" });
    expect(entry?.output).not.toContain("secret");
    expect(entry?.output).toContain("loginRequired");
  });

  it("orders results most-recent-first", () => {
    recordStep("terminal", "terminal", "static:alice", stepWithOneCall("first", { ok: true }));
    recordStep("terminal", "terminal", "static:alice", stepWithOneCall("second", { ok: true }));

    const entries = getToolLog({ owner: "static:alice", sessionKey: "terminal" });

    expect(entries.map((e) => e.toolName)).toEqual(["second", "first"]);
  });

  it("evicts a person's oldest entry once their log exceeds its max size", () => {
    for (let i = 0; i < 205; i++) {
      recordStep("terminal", "terminal", "static:alice", stepWithOneCall(`tool-${i}`, { ok: true }));
    }

    const entries = getToolLog({ owner: "static:alice" });

    expect(entries).toHaveLength(200);
    expect(entries[0]?.toolName).toBe("tool-204");
    expect(entries.at(-1)?.toolName).toBe("tool-5");
  });

  // Regression for #154: the log was one 200-entry ring for everyone, so a
  // busy person evicted everyone else's calls and their recall came back empty.
  it("a busy person never evicts someone else's entries", () => {
    recordStep("http", "bob:c1", "static:bob", stepWithOneCall("bob_tool", { ok: true }));
    for (let i = 0; i < 300; i++) {
      recordStep("http", "alice:c1", "static:alice", stepWithOneCall(`tool-${i}`, { ok: true }));
    }

    expect(getToolLog({ owner: "static:bob" }).map((e) => e.toolName)).toEqual(["bob_tool"]);
  });
});
