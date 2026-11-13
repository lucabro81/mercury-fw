import { describe, it, expect } from "bun:test";
import {
  listVerbatimBySession,
  listVerbatimSessions,
  listVerbatimTail,
  shownText,
} from "./verbatim-archive-store.ts";
import type { ConversationStore, StoredMessage } from "@mercury-fw/channel-types";
import { fakeConversationStore } from "./__fixtures__/fake-conversation-store.ts";

/** A store whose reads hand back `payloads` as they are (in the order a store gives them), recording each read's query. */
function storeWith(payloads: Array<Record<string, unknown>>, received: { query?: unknown } = {}): ConversationStore {
  const messages = payloads.map((p, i) => ({ id: `p${i}`, ...p }) as StoredMessage);
  return {
    ready: async () => {},
    append: async () => {},
    messages: async (q) => ((received.query = q), { messages }),
    recent: async (q) => ((received.query = q), messages),
    setTitle: async () => {},
    titles: async () => [],
    health: async () => ({ ok: true }),
  };
}


describe("listVerbatimBySession", () => {
  const msg = (sessionKey: string, role: "user" | "assistant", content: string, timestamp: string) => ({
    userId: "static:alice",
    sessionKey,
    role,
    content,
    timestamp,
  });

  it("reads the person's conversation oldest first, each message without its id, with the next page's cursor", async () => {
    const store = fakeConversationStore([
      msg("conv-1", "assistant", "ciao a te", "2026-09-22T12:00:01.000Z"),
      msg("conv-1", "user", "ciao", "2026-09-22T12:00:00.000Z"),
      msg("conv-1", "user", "e poi?", "2026-09-22T12:00:02.000Z"),
      msg("conv-2", "user", "another conversation", "2026-09-22T12:00:00.500Z"),
    ]);

    const result = await listVerbatimBySession(store, { userId: "static:alice", sessionKey: "conv-1", limit: 2 });

    expect(store.calls).toEqual([["messages", { userId: "static:alice", sessionKey: "conv-1", order: "asc", limit: 2 }]]);
    expect(result).toEqual({
      messages: [msg("conv-1", "user", "ciao", "2026-09-22T12:00:00.000Z"), msg("conv-1", "assistant", "ciao a te", "2026-09-22T12:00:01.000Z")],
      nextOffset: "2",
    });
  });

  it("forwards the cursor and reports null when there is no next page", async () => {
    const store = fakeConversationStore([msg("conv-1", "user", "a", "t1"), msg("conv-1", "user", "b", "t2")]);
    const result = await listVerbatimBySession(store, { userId: "static:alice", sessionKey: "conv-1", limit: 10, offset: "1" });
    expect(store.calls).toEqual([["messages", { userId: "static:alice", sessionKey: "conv-1", order: "asc", limit: 10, cursor: "1" }]]);
    expect(result).toEqual({ messages: [msg("conv-1", "user", "b", "t2")], nextOffset: null });
  });

  it("skips malformed messages instead of returning them", async () => {
    const result = await listVerbatimBySession(
      storeWith([{ content: 42 }, msg("conv-1", "assistant", "valid", "2026-09-22T12:00:02.000Z")]),
      { userId: "static:alice", sessionKey: "conv-1", limit: 50 },
    );
    expect(result.messages).toEqual([msg("conv-1", "assistant", "valid", "2026-09-22T12:00:02.000Z")]);
  });
});

describe("listVerbatimSessions", () => {
  const msg = (sessionKey: string, content: string, timestamp: string) => ({
    userId: "static:alice",
    sessionKey,
    role: "user" as const,
    content,
    timestamp,
  });

  it("reads the person's newest messages and dedups by sessionKey, keeping each conversation's most recent message", async () => {
    const store = fakeConversationStore([
      msg("conv-a", "older in a", "2026-09-24T12:00:00.000Z"),
      msg("conv-b", "latest in b", "2026-09-24T12:00:03.000Z"),
      msg("conv-a", "latest in a", "2026-09-24T12:00:02.000Z"),
      msg("conv-b", "older in b", "2026-09-24T12:00:01.000Z"),
    ]);

    const result = await listVerbatimSessions(store, { userId: "static:alice", limit: 10 });

    expect(store.calls).toEqual([["recent", { userId: "static:alice", limit: 500 }]]);
    expect(result).toEqual({
      conversations: [
        { sessionKey: "conv-b", lastTimestamp: "2026-09-24T12:00:03.000Z", preview: "latest in b" },
        { sessionKey: "conv-a", lastTimestamp: "2026-09-24T12:00:02.000Z", preview: "latest in a" },
      ],
    });
  });

  it("caps the number of returned conversations at limit", async () => {
    const store = fakeConversationStore([
      msg("conv-a", "a", "2026-09-24T12:00:03.000Z"),
      msg("conv-b", "b", "2026-09-24T12:00:02.000Z"),
      msg("conv-c", "c", "2026-09-24T12:00:01.000Z"),
    ]);
    const result = await listVerbatimSessions(store, { userId: "static:alice", limit: 2 });
    expect(result.conversations.map((c) => c.sessionKey)).toEqual(["conv-a", "conv-b"]);
  });
});

describe("listVerbatimTail", () => {
  const msg = (role: "user" | "assistant", content: string, second: number) => ({
    userId: "static:alice",
    sessionKey: "alice:conv-1",
    role,
    content,
    timestamp: `2026-10-12T10:00:${String(second).padStart(2, "0")}.000Z`,
  });
  const q = { userId: "static:alice", sessionKey: "alice:conv-1" };

  it("asks for the person's conversation newest first, and returns it in chronological order", async () => {
    const store = fakeConversationStore([msg("user", "mi piace il verde", 0), msg("assistant", "ok", 1), msg("user", "colore?", 2), msg("assistant", "verde", 3)]);

    const tail = await listVerbatimTail(store, { ...q, maxChars: 1000 });

    expect(store.calls).toEqual([["messages", { ...q, order: "desc", limit: 200 }]]);
    expect(tail).toEqual({
      messages: [
        { role: "user", content: "mi piace il verde", timestamp: "2026-10-12T10:00:00.000Z" },
        { role: "assistant", content: "ok", timestamp: "2026-10-12T10:00:01.000Z" },
        { role: "user", content: "colore?", timestamp: "2026-10-12T10:00:02.000Z" },
        { role: "assistant", content: "verde", timestamp: "2026-10-12T10:00:03.000Z" },
      ],
      complete: true,
    });
  });

  it("keeps only the newest messages that fit the budget, starting from a user message", async () => {
    // Newest first: "dddd"(4) + "cccc"(4) fit 10, "bb"(2) would make 10 too, "aaaa" no longer fits.
    const store = fakeConversationStore([msg("user", "aaaa", 0), msg("assistant", "bb", 1), msg("user", "cccc", 2), msg("assistant", "dddd", 3)]);

    const tail = await listVerbatimTail(store, { ...q, maxChars: 10 });

    // "bb" fits but is an assistant message: a tail never opens with one.
    // What came before the tail ends with "bb", the newest message left out.
    expect(tail).toEqual({
      messages: [
        { role: "user", content: "cccc", timestamp: "2026-10-12T10:00:02.000Z" },
        { role: "assistant", content: "dddd", timestamp: "2026-10-12T10:00:03.000Z" },
      ],
      complete: false,
      leftOutAt: "2026-10-12T10:00:01.000Z",
    });
  });

  it("is incomplete when the archive holds more than one page of the conversation", async () => {
    const many = Array.from({ length: 200 }, (_, i) => msg(i % 2 === 0 ? "assistant" : "user", "x", 59));
    const tail = await listVerbatimTail(storeWith(many), { ...q, maxChars: 10_000 });
    expect(tail.complete).toBe(false);
    expect(tail.messages[0]?.role).toBe("user");
  });

  it("is empty when even the newest message doesn't fit, or nothing is archived", async () => {
    expect(await listVerbatimTail(fakeConversationStore([msg("user", "a", 0), msg("assistant", "troppo lungo", 1)]), { ...q, maxChars: 5 })).toEqual({
      messages: [],
      complete: false,
      leftOutAt: "2026-10-12T10:00:01.000Z",
    });
    expect(await listVerbatimTail(fakeConversationStore(), { ...q, maxChars: 5 })).toEqual({ messages: [], complete: true });
  });

  it("skips malformed messages", async () => {
    expect(await listVerbatimTail(storeWith([{ content: 42 }, msg("user", "ciao", 0)]), { ...q, maxChars: 100 })).toEqual({
      messages: [{ role: "user", content: "ciao", timestamp: "2026-10-12T10:00:00.000Z" }],
      complete: true,
    });
  });
});

// #215: the archive kept only the model's answer, so a reopened conversation
// lost the lists (`present` displays) the person had seen with it.
describe("the displays a turn showed", () => {
  const LIST = "KAN-1 [In corso] Login\nhttps://example.atlassian.net/browse/KAN-1";
  const answer = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "assistant" as const,
    content: "Ecco le tue issue:",
    displays: [LIST],
    timestamp: "2026-10-15T10:00:01.000Z",
  };
  const question = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "user" as const,
    content: "Quali issue ho?",
    timestamp: "2026-10-15T10:00:00.000Z",
  };


  describe("shownText", () => {
    it("joins the answer and the displays with a blank line, as the turn's final text", () => {
      expect(shownText("Ecco le tue issue:", ["A", "B"])).toBe("Ecco le tue issue:\n\nA\n\nB");
    });

    it("is the displays alone when the answer is empty", () => {
      expect(shownText("", ["A"])).toBe("A");
    });

    it("is the answer alone without displays", () => {
      expect(shownText("ciao", undefined)).toBe("ciao");
      expect(shownText("ciao", [])).toBe("ciao");
    });

    it("skips empty parts", () => {
      expect(shownText("ciao", ["", "A"])).toBe("ciao\n\nA");
    });
  });

  it("listVerbatimBySession serves each message as it was shown, without a separate displays field", async () => {
    const result = await listVerbatimBySession(storeWith([question, answer]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });

    const { displays: _displays, ...rest } = answer;
    expect(result.messages).toEqual([question, { ...rest, content: `Ecco le tue issue:\n\n${LIST}` }]);
  });

  it("listVerbatimSessions previews what was shown", async () => {
    const result = await listVerbatimSessions(storeWith([{ ...answer, content: "" }]), {
      userId: "static:alice",
      limit: 10,
    });

    expect(result.conversations).toEqual([
      { sessionKey: "conv-1", lastTimestamp: answer.timestamp, preview: "KAN-1 [In corso] Login\nhttps://example.atlassian.net/browse/KAN-1" },
    ]);
  });

  it("listVerbatimTail, what goes back to the model, keeps the answer only", async () => {
    const tail = await listVerbatimTail(storeWith([answer, question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });

    expect(tail.messages).toEqual([
      { role: "user", content: "Quali issue ho?", timestamp: question.timestamp },
      { role: "assistant", content: "Ecco le tue issue:", timestamp: answer.timestamp },
    ]);
  });

  // A displays-only answer has no words of the model's own: what goes back to
  // the model leaves it out, as before such answers were archived, rather than
  // hand it an empty assistant message.
  it("listVerbatimTail leaves out an answer that was only displays", async () => {
    const tail = await listVerbatimTail(storeWith([{ ...answer, content: "" }, question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });

    expect(tail).toEqual({
      messages: [{ role: "user", content: "Quali issue ho?", timestamp: question.timestamp }],
      complete: true,
    });
  });

  it("listVerbatimSessions cuts the preview of what was shown at 120 characters", async () => {
    const long = "x".repeat(200);
    const result = await listVerbatimSessions(storeWith([{ ...answer, content: "Ecco:", displays: [long] }]), {
      userId: "static:alice",
      limit: 10,
    });

    expect(result.conversations[0]?.preview).toBe(`${`Ecco:\n\n${long}`.slice(0, 120)}…`);
  });

  it("reads a message without displays, archived before them, as it was", async () => {
    const result = await listVerbatimBySession(storeWith([question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });

    expect(result.messages).toEqual([question]);
  });
});

// A conversation picked up again must bring its tool calls back with it: as
// text only, it would show the model answers written from memory, and the
// model would stop calling tools (#351, #352). The person never sees them.
describe("the tool calls an answer was written from (#352)", () => {
  const calls = [
    { toolName: "jiraCommand", input: { command: "jira issue search --jql 'assignee = currentUser()'" }, result: { ok: true, ran: "jira issue search --jql 'assignee = currentUser()'", results: 1, displayRef: "d1" } },
  ];
  const answer = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "assistant" as const,
    content: "Hai una issue.",
    calls,
    timestamp: "2026-10-15T10:00:01.000Z",
  };
  const question = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "user" as const,
    content: "Quali issue ho?",
    timestamp: "2026-10-15T10:00:00.000Z",
  };


  it("listVerbatimTail, what goes back to the model, brings the calls back", async () => {
    const tail = await listVerbatimTail(storeWith([answer, question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });
    expect(tail.messages).toEqual([
      { role: "user", content: "Quali issue ho?", timestamp: question.timestamp },
      { role: "assistant", content: "Hai una issue.", calls, timestamp: answer.timestamp },
    ]);
  });

  it("listVerbatimTail counts the calls toward the budget", async () => {
    const fits = question.content.length + answer.content.length + JSON.stringify(calls).length;
    const query = { userId: "static:alice", sessionKey: "conv-1" };
    const whole = await listVerbatimTail(storeWith([answer, question]), { ...query, maxChars: fits });
    expect(whole.messages).toHaveLength(2);
    const short = await listVerbatimTail(storeWith([answer, question]), { ...query, maxChars: fits - 1 });
    expect(short.messages).toEqual([]);
  });

  it("listVerbatimBySession, what a UI renders, leaves the calls out", async () => {
    const result = await listVerbatimBySession(storeWith([question, answer]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });
    const { calls: _calls, ...shown } = answer;
    expect(result.messages).toEqual([question, shown]);
  });

  it("skips a point whose calls aren't a list of calls", async () => {
    const tail = await listVerbatimTail(storeWith([{ ...answer, calls: "nope" }, question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });
    expect(tail.messages).toEqual([{ role: "user", content: "Quali issue ho?", timestamp: question.timestamp }]);
  });
});

describe("an answer the turn's interruption cut short (#366)", () => {
  const marker = "[This answer was stopped before it was finished.]";
  const question = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "user" as const,
    content: "Quali issue ho?",
    timestamp: "2026-11-02T10:00:00.000Z",
  };
  const interrupted = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "assistant" as const,
    content: marker,
    interrupted: true as const,
    timestamp: "2026-11-02T10:00:01.000Z",
  };


  it("listVerbatimBySession, what a UI renders, serves it marked and without the model's text", async () => {
    const result = await listVerbatimBySession(storeWith([question, interrupted]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });
    expect(result.messages).toEqual([question, { ...interrupted, content: "" }]);
  });

  it("listVerbatimTail, what goes back to the model, hands back the text the history held", async () => {
    const tail = await listVerbatimTail(storeWith([interrupted, question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });
    expect(tail.messages).toEqual([
      { role: "user", content: "Quali issue ho?", timestamp: question.timestamp },
      { role: "assistant", content: marker, timestamp: interrupted.timestamp },
    ]);
  });

  it("listVerbatimSessions previews the question, at the time of the interruption", async () => {
    const result = await listVerbatimSessions(storeWith([interrupted, question]), {
      userId: "static:alice",
      limit: 10,
    });
    expect(result.conversations).toEqual([
      { sessionKey: "conv-1", lastTimestamp: interrupted.timestamp, preview: "Quali issue ho?" },
    ]);
  });

  it("listVerbatimSessions previews nothing when its scan holds only the interrupted answer", async () => {
    const result = await listVerbatimSessions(storeWith([interrupted]), {
      userId: "static:alice",
      limit: 10,
    });
    expect(result.conversations).toEqual([{ sessionKey: "conv-1", lastTimestamp: interrupted.timestamp, preview: "" }]);
  });

  it("skips a point whose mark isn't true", async () => {
    for (const mark of [false, "yes", 1]) {
      const tail = await listVerbatimTail(storeWith([{ ...interrupted, interrupted: mark }, question]), {
        userId: "static:alice",
        sessionKey: "conv-1",
        maxChars: 10_000,
      });
      expect(tail.messages).toEqual([{ role: "user", content: "Quali issue ho?", timestamp: question.timestamp }]);
    }
  });
});

describe("what the person saw of the turn besides its text (#370)", () => {
  const trace = [
    { type: "reasoning", text: "Look up the issues first." },
    { type: "tool", label: "Searching Jira", detail: "issue search", name: "jiraCommand", outcome: "success" },
    { type: "confirmation", id: "0123456789abcdef", command: "delete KAN-1", choices: [""] },
  ];
  const question = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "user" as const,
    content: "Cancella KAN-1",
    timestamp: "2026-11-03T10:00:00.000Z",
  };
  const answer = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "assistant" as const,
    content: "Action pending, waiting for confirmation.",
    pendingNote: "Action pending, waiting for confirmation.",
    trace,
    timestamp: "2026-11-03T10:00:01.000Z",
  };
  const outcome = {
    userId: "static:alice",
    sessionKey: "conv-1",
    role: "assistant" as const,
    content: "Done.",
    confirmation: { id: "0123456789abcdef", status: "ok" },
    timestamp: "2026-11-03T10:00:02.000Z",
  };
  const resumedOutcome = {
    ...outcome,
    content: "",
    confirmation: { id: "0123456789abcdef", status: "resume", choice: "Only this time" },
  };



  it("listVerbatimBySession, what a UI renders, serves the trace, the pending note and the outcome", async () => {
    const result = await listVerbatimBySession(storeWith([question, answer, outcome, resumedOutcome]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });
    expect(result.messages).toEqual([question, answer, outcome, resumedOutcome] as never);
  });

  it("listVerbatimBySession serves an interrupted answer's partial trace", async () => {
    const interrupted = { ...answer, content: "[stopped]", interrupted: true, pendingNote: undefined, trace: [trace[0]] };
    delete (interrupted as { pendingNote?: unknown }).pendingNote;
    const result = await listVerbatimBySession(storeWith([interrupted]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });
    expect(result.messages).toEqual([{ ...interrupted, content: "" }] as never);
  });

  it("listVerbatimTail, what goes back to the model, leaves out the trace, the pending note and the outcomes", async () => {
    const tail = await listVerbatimTail(storeWith([resumedOutcome, outcome, answer, question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });
    expect(tail.messages).toEqual([
      { role: "user", content: "Cancella KAN-1", timestamp: question.timestamp },
      { role: "assistant", content: answer.content, timestamp: answer.timestamp },
    ]);
    expect(tail.complete).toBe(true);
  });

  it("listVerbatimSessions previews the newest message that shows something, past an outcome with no reply", async () => {
    const result = await listVerbatimSessions(storeWith([resumedOutcome, outcome, answer]), {
      userId: "static:alice",
      limit: 10,
    });
    expect(result.conversations).toEqual([{ sessionKey: "conv-1", lastTimestamp: resumedOutcome.timestamp, preview: "Done." }]);
  });

  // An archive point whose trace or note isn't what this code wrote (a later
  // schema, a hand edit) still shows its answer: only the extra goes.
  it("drops a malformed trace or pending note, keeping the message", async () => {
    for (const bad of [{ trace: "nope" }, { trace: [{ label: "no type" }] }, { trace: [null] }, { pendingNote: 3 }]) {
      const result = await listVerbatimBySession(storeWith([{ ...answer, ...bad }]), {
        userId: "static:alice",
        sessionKey: "conv-1",
        limit: 50,
      });
      const kept = { ...answer } as Record<string, unknown>;
      for (const field of Object.keys(bad)) delete kept[field];
      expect(result.messages).toEqual([kept] as never);
    }
  });

  // A malformed outcome would otherwise read as an ordinary answer and go back to the model.
  it("skips a point whose confirmation outcome is malformed", async () => {
    for (const confirmation of ["ok", { id: "x", status: "maybe" }, { id: 1, status: "ok" }, { status: "ok" }, { id: "x", status: "ok", choice: 2 }]) {
      const tail = await listVerbatimTail(storeWith([{ ...outcome, confirmation }, question]), {
        userId: "static:alice",
        sessionKey: "conv-1",
        maxChars: 10_000,
      });
      expect(tail.messages).toEqual([{ role: "user", content: "Cancella KAN-1", timestamp: question.timestamp }]);
    }
  });
});
