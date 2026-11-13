import { describe, expect, it } from "bun:test";
import { archivedMessages, type TurnRecord } from "./index.ts";

const who = { sessionKey: "s1", person: { key: "u:alice" }, operator: false, as: "anyone" as const };
const turn = {
  ...who,
  kind: "turn" as const,
  turnId: "t1",
  multiUser: false,
  outcome: "done" as const,
  origin: "person" as const,
  input: "What's open on KAN?",
  startedAt: "2026-11-13T10:00:00.000Z",
  endedAt: "2026-11-13T10:00:05.000Z",
  answer: { content: "Two issues." },
};

describe("archivedMessages (#393)", () => {
  it("a turn the person wrote leaves their message, when it arrived, and the answer, when it ended", () => {
    const record: TurnRecord = {
      ...turn,
      answer: {
        content: "Two issues.",
        displays: ["- KAN-1", "- KAN-2"],
        calls: [{ toolName: "jira", input: {}, result: { ok: true, ran: "jira" } }],
        trace: [{ type: "tool", label: "Reading Jira" }],
      },
    };
    expect(archivedMessages(record)).toEqual([
      { userId: "u:alice", sessionKey: "s1", role: "user", content: "What's open on KAN?", turnId: "t1", timestamp: "2026-11-13T10:00:00.000Z" },
      {
        userId: "u:alice",
        sessionKey: "s1",
        role: "assistant",
        content: "Two issues.",
        displays: ["- KAN-1", "- KAN-2"],
        calls: [{ toolName: "jira", input: {}, result: { ok: true, ran: "jira" } }],
        trace: [{ type: "tool", label: "Reading Jira" }],
        turnId: "t1",
        timestamp: "2026-11-13T10:00:05.000Z",
      },
    ]);
  });

  it("an opening or a resumed turn leaves only its answer, with the pending note when it stood in", () => {
    for (const origin of ["opening", "resumed"] as const) {
      const { input: _input, ...rest } = turn;
      expect(archivedMessages({ ...rest, origin, answer: { content: "Hi, I'm Mercury.", pendingNote: "Hi" } })).toEqual([
        { userId: "u:alice", sessionKey: "s1", role: "assistant", content: "Hi, I'm Mercury.", pendingNote: "Hi", turnId: "t1", timestamp: "2026-11-13T10:00:05.000Z" },
      ]);
    }
  });

  it("leaves out a message with nothing shown: no words and no displays", () => {
    expect(archivedMessages({ ...turn, input: "  ", answer: { content: "", displays: [""] } })).toEqual([]);
    expect(archivedMessages({ ...turn, answer: { content: "", displays: ["- KAN-1"] } }).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("a cancelled turn leaves the person's message and the interrupted answer, only when the conversation kept one", () => {
    const answer = { content: "[interrupted]", interrupted: true as const, trace: [{ type: "reasoning" as const, text: "thinking" }] };
    expect(archivedMessages({ ...turn, outcome: "cancelled", answer })).toEqual([
      { userId: "u:alice", sessionKey: "s1", role: "user", content: "What's open on KAN?", turnId: "t1", timestamp: "2026-11-13T10:00:00.000Z" },
      { userId: "u:alice", sessionKey: "s1", role: "assistant", ...answer, turnId: "t1", timestamp: "2026-11-13T10:00:05.000Z" },
    ]);
    // Nothing half done: without the answer, not even the question.
    const { answer: _a, ...stopped } = turn;
    expect(archivedMessages({ ...stopped, outcome: "cancelled" })).toEqual([]);
  });

  it("a cancelled opening leaves nothing: nobody asked anything", () => {
    const { input: _input, ...rest } = turn;
    expect(archivedMessages({ ...rest, origin: "opening", outcome: "cancelled", answer: { content: "[interrupted]", interrupted: true } })).toEqual([]);
  });

  it("a failed turn leaves nothing", () => {
    const { answer: _a, ...failed } = turn;
    expect(archivedMessages({ ...failed, outcome: "failed" })).toEqual([]);
  });

  it("a resolved confirmation leaves the reply with how it went, even an empty one", () => {
    const base = { ...who, kind: "confirmation" as const, at: "2026-11-13T10:01:00.000Z" };
    expect(archivedMessages({ ...base, content: "Done.", confirmation: { id: "c1", status: "ok" } })).toEqual([
      { userId: "u:alice", sessionKey: "s1", role: "assistant", content: "Done.", confirmation: { id: "c1", status: "ok" }, timestamp: "2026-11-13T10:01:00.000Z" },
    ]);
    expect(archivedMessages({ ...base, content: "", confirmation: { id: "c1", status: "resume", choice: "Yes" } })).toEqual([
      {
        userId: "u:alice",
        sessionKey: "s1",
        role: "assistant",
        content: "",
        confirmation: { id: "c1", status: "resume", choice: "Yes" },
        timestamp: "2026-11-13T10:01:00.000Z",
      },
    ]);
  });
});
