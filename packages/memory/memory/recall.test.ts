import { describe, it, expect } from "bun:test";
import type { TurnRecord } from "@mercury-fw/plugin-types";
import { createVerbatimRecall } from "./recall.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

/** A recall on a fake index, counting what was embedded. */
function archive(opts: { background?: Array<() => Promise<void>> } = {}) {
  const index = fakeVectorIndex();
  const embedded: string[] = [];
  const provider = createVerbatimRecall({
    index,
    embed: async (text) => (embedded.push(text), [1, 2, 3]),
    ...(opts.background === undefined ? {} : { indexInBackground: (work) => void opts.background!.push(work) }),
  });
  /** The payloads indexed. */
  const indexed = () => (index.spaces.get("verbatim_archive") ?? []).map((p) => p.payload);
  return { provider, index, indexed, embedded };
}

const turn: TurnRecord = {
  sessionKey: "s",
  person: { key: "u" },
  operator: false,
  as: "anyone",
  kind: "turn",
  turnId: "t1",
  multiUser: false,
  outcome: "done",
  origin: "person",
  input: "come sta KAN-1?",
  startedAt: "2026-09-22T12:00:00.000Z",
  endedAt: "2026-09-22T12:00:04.000Z",
  answer: { content: "In Progress.", displays: ["- KAN-1"] },
};

describe("createVerbatimRecall — indexRecord (#393)", () => {
  it("indexes each message the record leaves, as the archive keeps it", async () => {
    const { provider, indexed, embedded } = archive();
    await provider.indexRecord(turn);
    expect(indexed()).toEqual([
      { userId: "u", sessionKey: "s", role: "user", content: "come sta KAN-1?", turnId: "t1", timestamp: "2026-09-22T12:00:00.000Z" },
      { userId: "u", sessionKey: "s", role: "assistant", content: "In Progress.", displays: ["- KAN-1"], turnId: "t1", timestamp: "2026-09-22T12:00:04.000Z" },
    ]);
    expect(embedded).toEqual(["come sta KAN-1?", "In Progress."]);
  });

  it("indexes a resolved confirmation, embedded on its choice when it has no reply", async () => {
    const { provider, embedded } = archive();
    await provider.indexRecord({
      sessionKey: "s",
      person: { key: "u" },
      operator: false,
      as: "anyone",
      kind: "confirmation",
      content: "",
      confirmation: { id: "c1", status: "resume", choice: "Only this time" },
      at: "2026-11-03T10:00:00.000Z",
    });
    expect(embedded).toEqual(["Only this time"]);
  });

  it("indexes nothing of the operator's", async () => {
    const { provider, indexed } = archive();
    await provider.indexRecord({ ...turn, operator: true });
    expect(indexed()).toEqual([]);
  });

  // #383: embedding a message is a model call: background work.
  it("hands each message's indexing to indexInBackground", async () => {
    const background: Array<() => Promise<void>> = [];
    const { provider, indexed } = archive({ background });
    await provider.indexRecord(turn);
    expect(indexed()).toEqual([]);
    expect(background).toHaveLength(2);
    for (const work of background) await work();
    expect(indexed().map((m) => (m as { role: string }).role)).toEqual(["user", "assistant"]);
  });
});

describe("createVerbatimRecall — recall_verbatim tool", () => {
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

    const tools = provider.sessionTools({ sessionKey: "spaces/X:users/42", userId: "users/42" });
    const result = await tools.recall_verbatim!.execute!({ query: "cosa dicevamo di KAN-1" }, {} as never);

    expect(result).toEqual({ ok: true, messages: [said] });
  });

  it("forwards a custom limit to the search", async () => {
    const { provider, index } = archive();
    const tools = provider.sessionTools({ sessionKey: "s", userId: "users/42" });
    await tools.recall_verbatim!.execute!({ query: "x", limit: 3 }, {} as never);
    expect((index.calls[0]![2] as { limit: number }).limit).toBe(3);
  });
});
