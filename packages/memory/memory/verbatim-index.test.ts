import { describe, it, expect } from "bun:test";
import { indexVerbatimMessage, searchVerbatim } from "./verbatim-index.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

/** An index whose verbatim_archive space holds `payloads`, all equally near any query. */
function indexWith(payloads: Array<Record<string, unknown>>) {
  return fakeVectorIndex({ verbatim_archive: payloads.map((payload, i) => ({ id: `p${i}`, vector: [1], payload })) });
}

/** Indexes `entry`: what the index got, its payloads with their ids (`stored`), and what was embedded. */
async function appended(entry: Parameters<typeof indexVerbatimMessage>[2]) {
  const index = fakeVectorIndex();
  const embedded: string[] = [];
  const embed = async (text: string) => (embedded.push(text), [1]);
  await indexVerbatimMessage(index, embed, entry);
  const indexed = index.spaces.get("verbatim_archive") ?? [];
  return { stored: indexed.map((p) => ({ id: p.id, ...p.payload })), indexed, embedded };
}

describe("indexVerbatimMessage", () => {
  const message = {
    userId: "users/42",
    sessionKey: "spaces/X:users/42",
    role: "user" as const,
    content: "come sta KAN-1?",
    timestamp: "2026-09-22T12:00:00.000Z",
  };

  it("indexes the message under a new id, its content embedded, the whole message for payload", async () => {
    const { indexed, embedded } = await appended(message);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(indexed[0]).toEqual({ id: indexed[0]!.id, vector: [1], payload: message });
    expect(embedded).toEqual(["come sta KAN-1?"]);
  });

  it("says when the index fails", async () => {
    const index = fakeVectorIndex();
    index.fail = new Error("index down");
    await expect(indexVerbatimMessage(index, async () => [1], message)).rejects.toThrow("index down");
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


  describe("indexVerbatimMessage", () => {
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

  it("searchVerbatim, what recall_verbatim hands the model, keeps the answer only", async () => {
    const results = await searchVerbatim(indexWith([answer]), async () => [1], {
      userId: "static:alice",
      queryText: "issue",
    });

    const { displays: _displays, ...rest } = answer;
    expect(results).toEqual([rest]);
  });

  it("searchVerbatim leaves out an answer that was only displays", async () => {
    const results = await searchVerbatim(
      indexWith([{ ...answer, content: "" }, question]),
      async () => [1],
      { userId: "static:alice", queryText: "issue" },
    );

    expect(results).toEqual([question]);
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

  it("searchVerbatim, what recall_verbatim hands the model, leaves the calls out", async () => {
    const results = await searchVerbatim(indexWith([answer]), async () => [1], {
      userId: "static:alice",
      queryText: "issue",
    });
    const { calls: _calls, ...said } = answer;
    expect(results).toEqual([said]);
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


  /** Indexes `entry`: the payload the index kept and what was embedded. */
  async function appendedOne(entry: Parameters<typeof indexVerbatimMessage>[2]) {
    const { stored, embedded } = await appended(entry);
    const { id: _id, ...payload } = stored[0]!;
    return { payload, embedded: embedded[0] };
  }

  it("keeps the trace and the pending note in the payload", async () => {
    expect((await appendedOne(answer as never)).payload as unknown).toEqual(answer);
  });

  it("keeps a confirmation's outcome in the payload, embedded on the reply", async () => {
    const { payload, embedded } = await appendedOne(outcome as never);
    expect(payload as unknown).toEqual(outcome);
    expect(embedded).toBe("Done.");
  });

  it("embeds an outcome with no reply (a resumed one) on its choice, else on how it went", async () => {
    expect((await appendedOne(resumedOutcome as never)).embedded).toBe("Only this time");
    expect((await appendedOne({ ...resumedOutcome, confirmation: { id: "x", status: "resume" } } as never)).embedded).toBe("resume");
  });

  it("searchVerbatim, what recall_verbatim hands the model, leaves out the trace, the pending note and the outcomes", async () => {
    const results = await searchVerbatim(indexWith([answer, outcome, resumedOutcome]), async () => [1], {
      userId: "static:alice",
      queryText: "KAN-1",
    });
    const { trace: _trace, pendingNote: _note, ...said } = answer;
    expect(results).toEqual([said]);
  });

});
