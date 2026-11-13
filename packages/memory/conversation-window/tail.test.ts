import { describe, expect, it } from "bun:test";
import type { ConversationStore, StoredMessage } from "@mercury-fw/plugin-types";
import { readTail } from "./tail.ts";

/** A store whose reads hand back `payloads` as they are (in the order a store gives them), recording each read's query. */
function storeWith(payloads: Array<Record<string, unknown>>, received: { queries: unknown[] } = { queries: [] }): ConversationStore {
  const messages = payloads.map((p, i) => ({ id: `p${i}`, ...p }) as StoredMessage);
  return {
    ready: async () => {},
    append: async () => {},
    messages: async (q) => (received.queries.push(q), { messages }),
    recent: async () => messages,
    setTitle: async () => {},
    titles: async () => [],
    health: async () => ({ ok: true }),
  };
}

/** `payloads` newest first, as a store reads them with `order: "desc"`. */
const newestFirst = (payloads: Array<Record<string, unknown>>) => [...payloads].reverse();

const msg = (role: "user" | "assistant", content: string, second: number) => ({
  userId: "static:alice",
  sessionKey: "alice:conv-1",
  role,
  content,
  timestamp: `2026-10-12T10:00:${String(second).padStart(2, "0")}.000Z`,
});
const q = { userId: "static:alice", sessionKey: "alice:conv-1" };

describe("readTail", () => {
  it("asks for the person's conversation newest first, and returns it in chronological order", async () => {
    const received = { queries: [] as unknown[] };
    const store = storeWith(newestFirst([msg("user", "mi piace il verde", 0), msg("assistant", "ok", 1), msg("user", "colore?", 2), msg("assistant", "verde", 3)]), received);

    const tail = await readTail(store, { ...q, maxChars: 1000 });

    expect(received.queries).toEqual([{ ...q, order: "desc", limit: 200 }]);
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
    const store = storeWith(newestFirst([msg("user", "aaaa", 0), msg("assistant", "bb", 1), msg("user", "cccc", 2), msg("assistant", "dddd", 3)]));

    const tail = await readTail(store, { ...q, maxChars: 10 });

    // "bb" fits but is an answer: a tail never opens with one.
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
    const tail = await readTail(storeWith(many), { ...q, maxChars: 10_000 });
    expect(tail.complete).toBe(false);
    expect(tail.messages[0]?.role).toBe("user");
  });

  it("is empty when even the newest message doesn't fit, or nothing is archived", async () => {
    expect(await readTail(storeWith(newestFirst([msg("user", "a", 0), msg("assistant", "troppo lungo", 1)])), { ...q, maxChars: 5 })).toEqual({
      messages: [],
      complete: false,
      leftOutAt: "2026-10-12T10:00:01.000Z",
    });
    expect(await readTail(storeWith([]), { ...q, maxChars: 5 })).toEqual({ messages: [], complete: true });
  });

  it("skips malformed messages, and keeps a message whose calls aren't calls without them", async () => {
    expect(
      await readTail(storeWith([{ content: 42 }, { ...msg("assistant", "fatto", 1), calls: "nope" }, msg("user", "ciao", 0)]), { ...q, maxChars: 100 }),
    ).toEqual({
      messages: [
        { role: "user", content: "ciao", timestamp: "2026-10-12T10:00:00.000Z" },
        { role: "assistant", content: "fatto", timestamp: "2026-10-12T10:00:01.000Z" },
      ],
      complete: true,
    });
  });

  it("brings back an answer's calls, counted toward the budget", async () => {
    const calls = [{ toolName: "jiraCommand", input: { command: "jira issue list" }, result: { ok: true, ran: "jira issue list" } }];
    const answer = { ...msg("assistant", "due issue", 1), calls };
    expect((await readTail(storeWith(newestFirst([msg("user", "issue?", 0), answer])), { ...q, maxChars: 1000 })).messages).toEqual([
      { role: "user", content: "issue?", timestamp: "2026-10-12T10:00:00.000Z" },
      { role: "assistant", content: "due issue", calls, timestamp: "2026-10-12T10:00:01.000Z" },
    ]);
    const tight = "issue?".length + "due issue".length + JSON.stringify(calls).length - 1;
    expect((await readTail(storeWith(newestFirst([msg("user", "issue?", 0), answer])), { ...q, maxChars: tight })).messages).toEqual([]);
  });

  // #215: what goes back to the model is what it said, never the lists the person saw.
  describe("what the person saw besides the answer", () => {
    const LIST = "KAN-1 [In corso] Login\nhttps://example.atlassian.net/browse/KAN-1";
    const question = msg("user", "Quali issue ho?", 0);
    const answer = { ...msg("assistant", "Ecco le tue issue:", 1), displays: [LIST], trace: [{ type: "status", label: "Jira" }], pendingNote: "x" };

    it("keeps the answer's own words only", async () => {
      expect((await readTail(storeWith([answer, question]), { ...q, maxChars: 10_000 })).messages).toEqual([
        { role: "user", content: "Quali issue ho?", timestamp: question.timestamp },
        { role: "assistant", content: "Ecco le tue issue:", timestamp: answer.timestamp },
      ]);
    });

    it("leaves out an answer that was only displays, or blank space", async () => {
      for (const content of ["", " \n "]) {
        expect(await readTail(storeWith([{ ...answer, content }, question]), { ...q, maxChars: 10_000 })).toEqual({
          messages: [{ role: "user", content: "Quali issue ho?", timestamp: question.timestamp }],
          complete: true,
        });
      }
    });

    it("leaves out how a confirmation was resolved, well formed or not", async () => {
      for (const confirmation of [{ id: "x", status: "ok" }, "ok", { id: 1, status: "ok" }]) {
        const outcome = { ...msg("assistant", "Done.", 2), confirmation };
        expect((await readTail(storeWith([outcome, question]), { ...q, maxChars: 10_000 })).messages).toEqual([
          { role: "user", content: "Quali issue ho?", timestamp: question.timestamp },
        ]);
      }
    });
  });
});
