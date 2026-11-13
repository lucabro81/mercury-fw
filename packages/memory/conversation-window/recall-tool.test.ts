import { describe, expect, it } from "bun:test";
import type { ToolLog, ToolLogEntry } from "@mercury-fw/plugin-types";
import { createRecallToolCalls } from "./recall-tool.ts";

/** One logged call of `owner` on `sessionKey`. */
const entry = (owner: string, sessionKey: string, toolName: string, input = "{}"): ToolLogEntry => ({
  timestamp: "2026-11-13T10:00:00.000Z",
  channel: "http",
  sessionKey,
  owner,
  toolName,
  input,
  output: "{\"ok\":true}",
});

/** A tool log over `entries` (oldest first), recording what it was asked. */
function logOf(entries: ToolLogEntry[]) {
  const asked: unknown[] = [];
  const log: ToolLog = {
    read: (q) => (asked.push(q), entries.filter((e) => e.owner === q.person && (q.sessionKey === undefined || e.sessionKey === q.sessionKey))),
  };
  return { log, asked };
}

/** Runs the tool for `alice` on session `s` with `input`. */
async function recall(log: ToolLog, input: { limit?: number } = {}) {
  const { recall_tool_calls } = createRecallToolCalls({ toolLog: log, sessionKey: "s", person: "static:alice" });
  return (await recall_tool_calls.execute!(input, {} as never)) as { ok: true; entries: ToolLogEntry[] };
}

describe("recall_tool_calls", () => {
  it("reads the person's calls of this conversation only, newest first", async () => {
    const { log, asked } = logOf([entry("static:alice", "s", "first"), entry("static:alice", "other", "elsewhere"), entry("static:bob", "s", "bob's"), entry("static:alice", "s", "second")]);
    const result = await recall(log);
    expect(asked).toEqual([{ person: "static:alice", sessionKey: "s" }]);
    expect(result).toEqual({ ok: true, entries: [entry("static:alice", "s", "second"), entry("static:alice", "s", "first")] });
  });

  it("gives at most 10 by default, and as many as asked up to 50", async () => {
    const many = Array.from({ length: 60 }, (_, i) => entry("static:alice", "s", `tool-${i}`));
    expect((await recall(logOf(many).log)).entries.map((e) => e.toolName)).toEqual(Array.from({ length: 10 }, (_, i) => `tool-${59 - i}`));
    expect((await recall(logOf(many).log, { limit: 2 })).entries.map((e) => e.toolName)).toEqual(["tool-59", "tool-58"]);
    const { recall_tool_calls } = createRecallToolCalls({ toolLog: logOf(many).log, sessionKey: "s", person: "static:alice" });
    expect(recall_tool_calls.inputSchema).toBeDefined();
  });

  it("never names the assistant in its description", () => {
    const { recall_tool_calls } = createRecallToolCalls({ toolLog: logOf([]).log, sessionKey: "s", person: "static:alice" });
    expect(recall_tool_calls.description).not.toContain("Mercury");
  });
});
