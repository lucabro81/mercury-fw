/**
 * Regression tests for #68: an unreachable Qdrant at startup made the four
 * `ensure…Collection` awaits reject `composeMercury` and crash the process.
 * The setup now runs in the background and retries until Qdrant answers.
 */
import { describe, it, expect } from "bun:test";
import { embeddingDimensions, MIGRATED_SPACES, setUpMemory, setUpWhenReachable } from "./collection-setup.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

describe("setUpWhenReachable", () => {
  it("runs the setup once and logs nothing when Qdrant answers at once", async () => {
    let calls = 0;
    const logs: string[] = [];
    const { done } = setUpWhenReachable(async () => void calls++, { log: (m) => logs.push(m), retryMs: 1 });

    await done;

    expect(calls).toBe(1);
    expect(logs).toEqual([]);
  });

  it("doesn't throw when Qdrant is down, retries, and says when memory is back", async () => {
    let calls = 0;
    const logs: string[] = [];
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 4) throw new Error("ConnectionRefused");
      },
      { log: (m) => logs.push(m), retryMs: 1 },
    );

    await done;

    expect(calls).toBe(4);
    // One line when it goes missing, one when it's back: not one per retry.
    expect(logs).toEqual([
      "memory unreachable (the vector index or the embedding model), Layer-3 memory is off until it answers (retrying every 0.001s): Error: ConnectionRefused",
      "memory reachable, its spaces ready",
    ]);
  });

  it("logs Qdrant going missing once, however many retries fail", async () => {
    let calls = 0;
    const logs: string[] = [];
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 20) throw new Error("down");
      },
      { log: (m) => logs.push(m), retryMs: 1 },
    );

    await done;

    expect(calls).toBe(20);
    expect(logs.filter((m) => m.startsWith("memory unreachable"))).toHaveLength(1);
    expect(logs).toHaveLength(2);
  });

  it("stops retrying after the first success", async () => {
    let calls = 0;
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 2) throw new Error("down");
      },
      { log: () => {}, retryMs: 1 },
    );

    await done;
    await Bun.sleep(20);

    expect(calls).toBe(2);
  });
});

// #23: the memory store going missing and coming back reach the traces.
describe("setUpWhenReachable: memory store events", () => {
  it("emits an error when Qdrant goes missing and a recovery when it's back, once each", async () => {
    const events: Array<Record<string, unknown>> = [];
    let calls = 0;
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 3) throw new Error("ConnectionRefused");
      },
      { log: () => {}, retryMs: 1, emit: (e) => void events.push(e) },
    );
    await done;
    expect(events).toEqual([
      { kind: "system.error", area: "memory-store", args: { error: "Error: ConnectionRefused" } },
      { kind: "system.recovered", area: "memory-store" },
    ]);
  });
});

describe("embeddingDimensions", () => {
  // #379: the spaces are as long as the embedding model's vectors, found by
  // embedding once instead of being configured by hand.
  it("is the length of the embedding model's vector", async () => {
    const texts: string[] = [];
    expect(await embeddingDimensions(async (text) => (texts.push(text), new Array(768).fill(0.1)))).toBe(768);
    expect(texts).toHaveLength(1);
  });

  it("refuses an empty vector, so no space is made with no dimensions", async () => {
    await expect(embeddingDimensions(async () => [])).rejects.toThrow("the embedding model returned an empty vector");
  });
});

describe("setUpMemory", () => {
  const client = () => {
    const calls: string[] = [];
    return {
      calls,
      qdrant: {
        getCollections: async () => (calls.push("getCollections"), { collections: [] }),
        createCollection: async (name: string, params: { vectors: { size: number } }) => void calls.push(`create ${name} ${params.vectors.size}`),
        upsert: async () => ({}),
        query: async () => ({ points: [] }),
        createPayloadIndex: async (name: string, params: { field_name: string }) => void calls.push(`index ${name} ${params.field_name}`),
      },
    };
  };

  it("makes the index's three spaces as long as the embedding model's vectors, then the archive and the titles", async () => {
    const index = fakeVectorIndex();
    const { qdrant, calls } = client();
    await setUpMemory({ index, embed: async () => [0, 0, 0], qdrant, collections: { verbatim: "verbatim_archive", titles: "conversation_titles" } });
    expect(index.calls).toEqual([
      ["ensure", "episodic_memory", { dimensions: 3, keys: ["userId", "sessionKey"], ordered: ["timestamp"] }],
      ["ensure", "semantic_facts", { dimensions: 3 }],
      ["ensure", "tool_corrections", { dimensions: 3 }],
    ]);
    expect(calls).toContain("create verbatim_archive 3");
    expect(calls).toContain("create conversation_titles 1");
  });

  // Regression guard: the titles hold no vectors; an embedding model that
  // isn't answering must not keep their collection from being made.
  it("makes the titles' collection before asking the embedding model anything", async () => {
    const { qdrant, calls } = client();
    const failing = async () => {
      throw new Error("embedding model down");
    };
    await expect(
      setUpMemory({ index: fakeVectorIndex(), embed: failing, qdrant, collections: { verbatim: "verbatim_archive", titles: "conversation_titles" } }),
    ).rejects.toThrow("embedding model down");
    expect(calls).toContain("create conversation_titles 1");
    expect(calls.some((c) => c.startsWith("create verbatim_archive"))).toBe(false);
  });

  it("without an index, makes only the archive and the titles", async () => {
    const { qdrant, calls } = client();
    await setUpMemory({ embed: async () => [0, 0], qdrant, collections: { verbatim: "verbatim_archive", titles: "conversation_titles" } });
    expect(calls).toContain("create verbatim_archive 2");
    expect(calls).toContain("create conversation_titles 1");
  });

  it("names the spaces whose userIds the user-key migration rewrites", () => {
    expect(MIGRATED_SPACES).toEqual(["episodic_memory", "semantic_facts", "verbatim_archive"]);
  });
});
