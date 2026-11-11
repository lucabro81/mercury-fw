import { describe, it, expect } from "bun:test";
import {
  appendVerbatimMessage,
  searchVerbatim,
  listVerbatimBySession,
  listVerbatimSessions,
  listVerbatimTail,
  shownText,
} from "./verbatim-archive-store.ts";
import type { ConversationStore, StoredMessage } from "@mercury-fw/channel-types";
import { fakeConversationStore } from "./__fixtures__/fake-conversation-store.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

/** An index whose verbatim_archive space holds `payloads`, all equally near any query. */
function indexWith(payloads: Array<Record<string, unknown>>) {
  return fakeVectorIndex({ verbatim_archive: payloads.map((payload, i) => ({ id: `p${i}`, vector: [1], payload })) });
}

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

/** Appends `entry` to a store and an index: what the store kept, what the index got and what was embedded. */
async function appended(entry: Parameters<typeof appendVerbatimMessage>[1], withIndex = true) {
  const store = fakeConversationStore();
  const index = fakeVectorIndex();
  const embedded: string[] = [];
  const embed = async (text: string) => (embedded.push(text), [1]);
  await appendVerbatimMessage(store, entry, withIndex ? { index, embed } : undefined);
  return { stored: store.stored, indexed: index.spaces.get("verbatim_archive") ?? [], embedded };
}

describe("appendVerbatimMessage", () => {
  const message = {
    userId: "users/42",
    sessionKey: "spaces/X:users/42",
    role: "user" as const,
    content: "come sta KAN-1?",
    timestamp: "2026-09-22T12:00:00.000Z",
  };

  it("keeps the message in the store under a new id, and indexes it under the same id with its content embedded", async () => {
    const { stored, indexed, embedded } = await appended(message);

    expect(stored).toHaveLength(1);
    const { id, ...kept } = stored[0]!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(kept).toEqual(message);
    expect(indexed).toEqual([{ id, vector: [1], payload: message }]);
    expect(embedded).toEqual(["come sta KAN-1?"]);
  });

  // #379: the store is the record, the index derived from it: an index that
  // fails keeps the message out of the search, never out of the archive.
  it("keeps the message in the store when the index fails, and says the index failed", async () => {
    const store = fakeConversationStore();
    const index = fakeVectorIndex();
    index.fail = new Error("index down");
    await expect(appendVerbatimMessage(store, message, { index, embed: async () => [1] })).rejects.toThrow("index down");
    expect(store.stored.map(({ id: _id, ...m }) => m)).toEqual([message]);
  });

  // #379: without a vector index the archive still keeps what was said; nothing is embedded.
  it("without a search, keeps the message and embeds nothing", async () => {
    const { stored, embedded } = await appended({ ...message, role: "assistant", content: "KAN-1 è In Progress." }, false);
    expect(stored.map(({ id: _id, ...m }) => m)).toEqual([{ ...message, role: "assistant", content: "KAN-1 è In Progress." }]);
    expect(embedded).toEqual([]);
  });
});

describe("searchVerbatim", () => {
  const message = (content: string, extra: Record<string, unknown> = {}) => ({
    userId: "users/42",
    sessionKey: "spaces/X:users/42",
    role: "user",
    content,
    timestamp: "2026-09-15T09:00:00.000Z",
    ...extra,
  });

  it("embeds queryText, searches only the person's archived messages, nearest first", async () => {
    const index = fakeVectorIndex({
      verbatim_archive: [
        { id: "p1", vector: [1, 0, 0], payload: message("la settimana scorsa dicevamo di KAN-1") },
        { id: "p2", vector: [1, 0, 0], payload: message("someone else's", { userId: "users/7" }) },
      ],
    });
    const embed = async (text: string) => [text.length, 0, 0];

    const results: unknown[] = await searchVerbatim(index, embed, { userId: "users/42", queryText: "cosa dicevamo di KAN-1" });

    expect(index.calls).toEqual([
      ["query", "verbatim_archive", { vector: ["cosa dicevamo di KAN-1".length, 0, 0], where: { userId: "users/42" }, limit: 5 }],
    ]);
    expect(results).toEqual([message("la settimana scorsa dicevamo di KAN-1")]);
  });

  it("asks for a custom limit instead of the default", async () => {
    const index = fakeVectorIndex();
    await searchVerbatim(index, async () => [0], { userId: "users/42", queryText: "x", limit: 10 });
    expect((index.calls[0]![2] as { limit: number }).limit).toBe(10);
  });

  // A malformed point could exist from an older schema: skip rather than
  // crash or return a malformed VerbatimMessage.
  it("skips points with a malformed payload instead of throwing", async () => {
    const index = fakeVectorIndex({
      verbatim_archive: [
        { id: "p2", vector: [1], payload: { content: 42 } },
        { id: "p3", vector: [1], payload: message("hi", { role: "captain" }) },
        { id: "p4", vector: [1], payload: message("valid one", { role: "assistant", sessionKey: "terminal" }) },
      ],
    });
    const results: unknown[] = await searchVerbatim(index, async () => [1], { userId: "users/42", queryText: "x" });
    expect(results).toEqual([
      message("valid one", { role: "assistant", sessionKey: "terminal" }),
    ]);
  });

  it("is empty when nothing matches", async () => {
    expect(await searchVerbatim(fakeVectorIndex(), async () => [0], { userId: "users/42", queryText: "x" })).toEqual([]);
  });
});

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

  describe("appendVerbatimMessage", () => {
    it("keeps the displays in the payload and embeds the answer", async () => {
      const { stored, indexed, embedded } = await appended(answer);
      const { id: _id, ...payload } = stored[0]!;
      expect(payload).toEqual(answer);
      expect(indexed[0]?.payload).toEqual(answer);
      expect(embedded).toEqual(["Ecco le tue issue:"]);
    });

    it("embeds what was shown when the answer is empty", async () => {
      expect((await appended({ ...answer, content: "" })).embedded).toEqual([LIST]);
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

  it("searchVerbatim, what recall_verbatim hands the model, keeps the answer only", async () => {
    const results = await searchVerbatim(indexWith([answer]), async () => [1], {
      userId: "static:alice",
      queryText: "issue",
    });

    const { displays: _displays, ...rest } = answer;
    expect(results).toEqual([rest]);
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

  it("an answer of blank space with displays counts as only displays", async () => {
    const tail = await listVerbatimTail(storeWith([{ ...answer, content: " \n " }, question]), {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });
    expect(tail.messages).toEqual([{ role: "user", content: "Quali issue ho?", timestamp: question.timestamp }]);

    expect((await appended({ ...answer, content: " " })).embedded).toEqual([` \n\n${LIST}`]);
  });

  it("searchVerbatim leaves out an answer that was only displays", async () => {
    const results = await searchVerbatim(
      indexWith([{ ...answer, content: "" }, question]),
      async () => [1],
      { userId: "static:alice", queryText: "issue" },
    );

    expect(results).toEqual([question]);
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


  it("keeps the calls in the payload", async () => {
    const { id: _id, ...payload } = (await appended(answer)).stored[0]!;
    expect(payload).toEqual(answer);
  });

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

  it("searchVerbatim, what recall_verbatim hands the model, leaves the calls out", async () => {
    const results = await searchVerbatim(indexWith([answer]), async () => [1], {
      userId: "static:alice",
      queryText: "issue",
    });
    const { calls: _calls, ...said } = answer;
    expect(results).toEqual([said]);
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


  it("keeps the mark in the payload", async () => {
    const { id: _id, ...payload } = (await appended(interrupted)).stored[0]!;
    expect(payload).toEqual(interrupted);
  });

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


  /** Appends `entry`: the payload the store kept (its id aside) and what was embedded. */
  async function appendedOne(entry: Parameters<typeof appendVerbatimMessage>[1]) {
    const { stored, embedded } = await appended(entry);
    const { id: _id, ...payload } = stored[0]!;
    return { payload, embedded: embedded[0] };
  }

  it("keeps the trace and the pending note in the payload", async () => {
    expect((await appendedOne(answer as never)).payload).toEqual(answer);
  });

  it("keeps a confirmation's outcome in the payload, embedded on the reply", async () => {
    const { payload, embedded } = await appendedOne(outcome as never);
    expect(payload).toEqual(outcome);
    expect(embedded).toBe("Done.");
  });

  it("embeds an outcome with no reply (a resumed one) on its choice, else on how it went", async () => {
    expect((await appendedOne(resumedOutcome as never)).embedded).toBe("Only this time");
    expect((await appendedOne({ ...resumedOutcome, confirmation: { id: "x", status: "resume" } } as never)).embedded).toBe("resume");
  });

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

  it("searchVerbatim, what recall_verbatim hands the model, leaves out the trace, the pending note and the outcomes", async () => {
    const results = await searchVerbatim(indexWith([answer, outcome, resumedOutcome]), async () => [1], {
      userId: "static:alice",
      queryText: "KAN-1",
    });
    const { trace: _trace, pendingNote: _note, ...said } = answer;
    expect(results).toEqual([said]);
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
