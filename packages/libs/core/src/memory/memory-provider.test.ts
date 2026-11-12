import { describe, it, expect } from "bun:test";
import { createVerbatimArchiveProvider } from "./memory-provider.ts";
import { fakeConversationStore } from "./__fixtures__/fake-conversation-store.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

/** A provider on a fake store and, unless `withIndex` is false, a fake index, at the clock `at`. */
function archive(at = "2026-09-22T12:00:00.000Z", withIndex = true) {
  const store = fakeConversationStore();
  const index = fakeVectorIndex();
  let embedCalls = 0;
  const provider = createVerbatimArchiveProvider({
    store,
    embed: async () => (embedCalls++, [1, 2, 3]),
    ...(withIndex ? { index } : {}),
    now: () => new Date(at),
  });
  /** What the store kept, without the ids it was given. */
  const kept = () => store.stored.map(({ id: _id, ...m }) => m);
  return { provider, store, index, kept, embedCalls: () => embedCalls };
}

describe("createVerbatimArchiveProvider — captureExchange", () => {
  it("stamps the timestamp from the injected clock, keeps the message in the store and indexes it under the same id", async () => {
    const { provider, store, index, kept } = archive();

    await provider.captureExchange!({ userId: "users/42", sessionKey: "spaces/X:users/42", role: "user", content: "come sta KAN-1?" });

    const message = { userId: "users/42", sessionKey: "spaces/X:users/42", role: "user", content: "come sta KAN-1?", timestamp: "2026-09-22T12:00:00.000Z" };
    expect(kept()).toEqual([message]);
    expect(index.spaces.get("verbatim_archive")).toEqual([{ id: store.stored[0]!.id, vector: [1, 2, 3], payload: message }]);
  });

  // #383: the indexing embeds, a model call nobody waits on: it goes to indexInBackground.
  it("hands the indexing to indexInBackground; the store has the message before", async () => {
    const store = fakeConversationStore();
    const index = fakeVectorIndex();
    const later: Array<() => Promise<void>> = [];
    const provider = createVerbatimArchiveProvider({ store, index, embed: async () => [1], indexInBackground: (work) => void later.push(work) });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "user", content: "ciao" });
    expect(store.stored).toHaveLength(1);
    expect(index.spaces.get("verbatim_archive") ?? []).toEqual([]);
    await later[0]!();
    expect(index.spaces.get("verbatim_archive")).toHaveLength(1);
  });

  // #379: without a vector index the archive still keeps what was said, and nothing is embedded.
  it("without an index, keeps the message and embeds nothing", async () => {
    const { provider, kept, embedCalls } = archive(undefined, false);
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "user", content: "ciao" });
    expect(kept()).toHaveLength(1);
    expect(embedCalls()).toBe(0);
  });

  // Regression: a turn whose model output is only a present()/tool call (no
  // prose) leaves the assistant text empty. Capturing it would store a
  // meaningless empty message AND risk embed("") throwing — which, being the
  // second capture await, would strand the already-captured user message with
  // no assistant counterpart. Empty content must be skipped, not stored.
  it("skips capture entirely when the content is empty or whitespace-only", async () => {
    const { provider, store, embedCalls } = archive();

    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "" });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "   \n  " });

    expect(store.stored).toEqual([]);
    expect(embedCalls()).toBe(0);
  });

  // #215: the archive keeps what the turn showed after the answer.
  it("archives the displays with the answer, and an answer that is only displays", async () => {
    const { provider, kept } = archive("2026-10-15T10:00:00.000Z");

    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "Ecco:", displays: ["KAN-1"] });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "", displays: ["KAN-2"] });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: " ", displays: [""] });

    expect(kept()).toEqual([
      { userId: "u", sessionKey: "s", role: "assistant", content: "Ecco:", displays: ["KAN-1"], timestamp: "2026-10-15T10:00:00.000Z" },
      { userId: "u", sessionKey: "s", role: "assistant", content: "", displays: ["KAN-2"], timestamp: "2026-10-15T10:00:00.000Z" },
    ]);
  });

  // #366: a cancelled turn's answer is archived marked, so a UI can show the question was left unanswered.
  it("archives the mark of an interrupted answer", async () => {
    const { provider, kept } = archive("2026-11-02T10:00:00.000Z");

    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "[stopped]", interrupted: true });

    expect(kept()).toEqual([
      { userId: "u", sessionKey: "s", role: "assistant", content: "[stopped]", interrupted: true, timestamp: "2026-11-02T10:00:00.000Z" },
    ]);
  });

  // #370: what the person saw of the turn, and how a confirmation was resolved, even with no reply.
  it("archives the trace, the pending note, and a confirmation's outcome even when nothing was shown", async () => {
    const { provider, kept } = archive("2026-11-03T10:00:00.000Z");
    const trace = [{ type: "tool" as const, label: "Searching", outcome: "success" as const }];
    const confirmation = { id: "0123456789abcdef", status: "resume" as const };

    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "Pending.", pendingNote: "Pending.", trace });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "", confirmation });

    expect(kept()).toEqual([
      { userId: "u", sessionKey: "s", role: "assistant", content: "Pending.", pendingNote: "Pending.", trace, timestamp: "2026-11-03T10:00:00.000Z" },
      { userId: "u", sessionKey: "s", role: "assistant", content: "", confirmation, timestamp: "2026-11-03T10:00:00.000Z" },
    ]);
  });
});

describe("createVerbatimArchiveProvider — recall_verbatim tool", () => {
  const said = {
    userId: "users/42",
    sessionKey: "spaces/X:users/42",
    role: "assistant",
    content: "la settimana scorsa KAN-1 era In Review",
    timestamp: "2026-09-15T09:00:00.000Z",
  };

  it("searches the index scoped to the context's userId and returns the matched messages", async () => {
    const { provider, index } = archive();
    index.spaces.set("verbatim_archive", [
      { id: "p1", vector: [1, 2, 3], payload: said },
      { id: "p2", vector: [1, 2, 3], payload: { ...said, userId: "users/7", content: "not yours" } },
    ]);

    const tools = provider.sessionTools!({ sessionKey: "spaces/X:users/42", userId: "users/42" });
    const result = await tools.recall_verbatim!.execute!({ query: "cosa dicevamo di KAN-1" }, {} as never);

    expect(result).toEqual({ ok: true, messages: [said] });
  });

  it("forwards a custom limit to the search", async () => {
    const { provider, index } = archive();
    const tools = provider.sessionTools!({ sessionKey: "s", userId: "users/42" });
    await tools.recall_verbatim!.execute!({ query: "x", limit: 3 }, {} as never);
    expect((index.calls[0]![2] as { limit: number }).limit).toBe(3);
  });

  // Without a vector index nothing can find past messages by meaning: the
  // model isn't offered a tool that would always come back empty.
  it("offers no recall_verbatim without a vector index", () => {
    const { provider } = archive(undefined, false);
    expect(provider.sessionTools!({ sessionKey: "s", userId: "users/42" })).toEqual({});
  });
});
