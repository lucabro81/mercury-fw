import { describe, it, expect } from "bun:test";
import {
  ensureEpisodicCollection,
  storeEpisodicSummary,
  searchEpisodicMemory,
  getLastSessionEpisodicSummaries,
  getEpisodicSummariesBySession,
  type QdrantClientLike,
} from "./episodic-store.ts";

describe("ensureEpisodicCollection", () => {
  it("creates the collection if it doesn't already exist", async () => {
    let created: unknown;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async (name, params) => {
        created = { name, params };
        return {};
      },
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    await ensureEpisodicCollection(client, "episodic_memory", 768);

    expect(created).toEqual({
      name: "episodic_memory",
      params: { vectors: { size: 768, distance: "Cosine" } },
    });
  });

  it("does not recreate a collection that already exists", async () => {
    let createCalls = 0;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [{ name: "episodic_memory" }] }),
      createCollection: async () => {
        createCalls++;
        return {};
      },
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    await ensureEpisodicCollection(client, "episodic_memory", 768);

    expect(createCalls).toBe(0);
  });

  // Regression test: a fresh episodic_memory collection with no payload
  // indexes made getLastSessionEpisodicSummaries's order_by/filter scroll
  // queries fail with an HTTP 400 the first time a brand-new deployment's
  // context primer ran — Qdrant requires an index for both. Observed live
  // twice (once per fresh Qdrant volume) before this fix; previously
  // worked around by hand via the REST API instead of in code.
  it("creates the timestamp, userId and sessionKey payload indexes when creating a new collection", async () => {
    const indexCalls: Array<{ name: string; params: unknown }> = [];
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      createPayloadIndex: async (name, params) => {
        indexCalls.push({ name, params });
        return {};
      },
    };

    await ensureEpisodicCollection(client, "episodic_memory", 768);

    expect(indexCalls).toEqual([
      { name: "episodic_memory", params: { field_name: "timestamp", field_schema: "datetime" } },
      { name: "episodic_memory", params: { field_name: "userId", field_schema: "keyword" } },
      { name: "episodic_memory", params: { field_name: "sessionKey", field_schema: "keyword" } },
    ]);
  });

  // The self-healing case: a collection created before this fix existed
  // (or by any other means) never got its indexes — ensuring them must
  // not be conditional on "did we just create the collection".
  it("creates the payload indexes even when the collection already exists", async () => {
    const indexCalls: Array<{ name: string; params: unknown }> = [];
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [{ name: "episodic_memory" }] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      createPayloadIndex: async (name, params) => {
        indexCalls.push({ name, params });
        return {};
      },
    };

    await ensureEpisodicCollection(client, "episodic_memory", 768);

    expect(indexCalls).toHaveLength(3);
  });

  // createPayloadIndex is optional on QdrantClientLike (same reasoning as
  // `scroll`) — a minimal test double for a caller that doesn't care about
  // indexes must not be forced to stub it.
  it("does not throw when the client doesn't support createPayloadIndex", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    await expect(ensureEpisodicCollection(client, "episodic_memory", 768)).resolves.toBeUndefined();
  });
});

describe("storeEpisodicSummary", () => {
  it("upserts a point with the embedded summary and the full payload", async () => {
    let upserted: { collection: string; points: unknown[] } | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async (collection, params) => {
        upserted = { collection, points: params.points };
        return {};
      },
      query: async () => ({ points: [] }),
    };
    const embed = async (text: string) => [text.length, 0, 0];

    await storeEpisodicSummary(client, "episodic_memory", embed, {
      userId: "users/42",
      sessionKey: "spaces/X:users/42",
      summary: "discussed KAN-1 status",
      timestamp: "2026-07-17T12:00:00.000Z",
    });

    expect(upserted?.collection).toBe("episodic_memory");
    expect(upserted?.points).toHaveLength(1);
    const point = upserted!.points[0] as { id: string; vector: number[]; payload: Record<string, unknown> };
    expect(point.vector).toEqual([22, 0, 0]);
    expect(point.payload).toEqual({
      userId: "users/42",
      sessionKey: "spaces/X:users/42",
      summary: "discussed KAN-1 status",
      timestamp: "2026-07-17T12:00:00.000Z",
    });
    expect(typeof point.id).toBe("string");
  });
});

// The narrow need this serves: "how many times have I already notified
// this user about this item" — not a general-purpose semantic
// consolidation/pattern-extraction engine (that doesn't exist here).
// Filters by
// userId so one user's history never leaks into another's notification
// tone/frequency reasoning.
describe("searchEpisodicMemory", () => {
  it("embeds queryText, searches scoped to userId, and maps payloads back to EpisodicSummary", async () => {
    let receivedArgs: { collection: string; params: unknown } | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async (collection, params) => {
        receivedArgs = { collection, params };
        return {
          points: [
            {
              id: "p1",
              score: 0.91,
              payload: {
                userId: "users/42",
                sessionKey: "spaces/X:users/42",
                summary: "Mercury ha notificato KAN-1 il 2026-07-15",
                timestamp: "2026-07-15T09:00:00.000Z",
              },
            },
          ],
        };
      },
    };
    const embed = async (text: string) => [text.length, 0, 0];

    const results = await searchEpisodicMemory(client, "episodic_memory", embed, {
      userId: "users/42",
      queryText: "notifiche per KAN-1",
    });

    expect(receivedArgs?.collection).toBe("episodic_memory");
    expect(receivedArgs?.params).toEqual({
      query: [19, 0, 0],
      filter: { must: [{ key: "userId", match: { value: "users/42" } }] },
      limit: 5,
      with_payload: true,
    });
    expect(results).toEqual([
      {
        userId: "users/42",
        sessionKey: "spaces/X:users/42",
        summary: "Mercury ha notificato KAN-1 il 2026-07-15",
        timestamp: "2026-07-15T09:00:00.000Z",
      },
    ]);
  });

  it("respects a custom limit instead of the default", async () => {
    let receivedLimit: number | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async (_collection, params) => {
        receivedLimit = params.limit;
        return { points: [] };
      },
    };
    const embed = async () => [0, 0, 0];

    await searchEpisodicMemory(client, "episodic_memory", embed, { userId: "users/42", queryText: "x", limit: 2 });

    expect(receivedLimit).toBe(2);
  });

  // Qdrant allows a null payload on a point — skip it rather than crash
  // or return a malformed EpisodicSummary.
  it("skips results with a missing or malformed payload instead of throwing", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({
        points: [
          { id: "p1", score: 0.9, payload: null },
          { id: "p2", score: 0.8, payload: { summary: 42 } }, // wrong type
          {
            id: "p3",
            score: 0.7,
            payload: {
              userId: "users/42",
              sessionKey: "terminal",
              summary: "valid one",
              timestamp: "2026-07-15T09:00:00.000Z",
            },
          },
        ],
      }),
    };
    const embed = async () => [0, 0, 0];

    const results = await searchEpisodicMemory(client, "episodic_memory", embed, { userId: "users/42", queryText: "x" });

    expect(results).toEqual([
      { userId: "users/42", sessionKey: "terminal", summary: "valid one", timestamp: "2026-07-15T09:00:00.000Z" },
    ]);
  });

  it("returns an empty array when nothing matches", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };
    const embed = async () => [0, 0, 0];

    expect(await searchEpisodicMemory(client, "episodic_memory", embed, { userId: "users/42", queryText: "x" })).toEqual(
      [],
    );
  });
});

// Not similarity-scoped like searchEpisodicMemory: this answers "what
// happened last time", used to seed a brand-new session's context primer —
// there's no query yet to compare against at session start.
describe("getLastSessionEpisodicSummaries", () => {
  it("finds the most recent entry, then returns entries scoped exactly to its own sessionKey", async () => {
    const calls: unknown[] = [];
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (_collection, params) => {
        calls.push(params);
        if (calls.length === 1) {
          return {
            points: [
              {
                id: "p-latest",
                payload: {
                  userId: "users/42",
                  sessionKey: "spaces/X:users/42:session-B",
                  summary: "closed session summary A",
                  timestamp: "2026-07-25T18:00:00.000Z",
                },
              },
            ],
          };
        }
        return {
          points: [
            {
              id: "p2",
              payload: {
                userId: "users/42",
                sessionKey: "spaces/X:users/42:session-B",
                summary: "closed session summary B",
                timestamp: "2026-07-25T17:50:00.000Z",
              },
            },
            {
              id: "p1",
              payload: {
                userId: "users/42",
                sessionKey: "spaces/X:users/42:session-B",
                summary: "closed session summary A",
                timestamp: "2026-07-25T18:00:00.000Z",
              },
            },
          ],
        };
      },
    };

    const results = await getLastSessionEpisodicSummaries(client, "episodic_memory", { userId: "users/42" });

    expect(calls[0]).toEqual({
      filter: { must: [{ key: "userId", match: { value: "users/42" } }] },
      order_by: { key: "timestamp", direction: "desc" },
      limit: 1,
    });
    expect(calls[1]).toEqual({
      filter: {
        must: [
          { key: "userId", match: { value: "users/42" } },
          { key: "sessionKey", match: { value: "spaces/X:users/42:session-B" } },
        ],
      },
      order_by: { key: "timestamp", direction: "desc" },
      limit: 3,
    });
    expect(results).toEqual([
      {
        userId: "users/42",
        sessionKey: "spaces/X:users/42:session-B",
        summary: "closed session summary B",
        timestamp: "2026-07-25T17:50:00.000Z",
      },
      {
        userId: "users/42",
        sessionKey: "spaces/X:users/42:session-B",
        summary: "closed session summary A",
        timestamp: "2026-07-25T18:00:00.000Z",
      },
    ]);
  });

  it("returns an empty array when the user has no episodic history at all", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async () => ({ points: [] }),
    };

    expect(await getLastSessionEpisodicSummaries(client, "episodic_memory", { userId: "users/42" })).toEqual([]);
  });

  it("respects a custom limit on the session-scoped fetch instead of the default", async () => {
    let callCount = 0;
    let secondCallLimit: number | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (_collection, params) => {
        callCount++;
        if (callCount === 1) {
          return {
            points: [
              {
                id: "p1",
                payload: {
                  userId: "users/42",
                  sessionKey: "spaces/X:users/42",
                  summary: "s",
                  timestamp: "2026-07-25T18:00:00.000Z",
                },
              },
            ],
          };
        }
        secondCallLimit = params.limit;
        return { points: [] };
      },
    };

    await getLastSessionEpisodicSummaries(client, "episodic_memory", { userId: "users/42", limit: 5 });

    expect(secondCallLimit).toBe(5);
  });

  // Regression guard: the session boundary must be enforced by the query
  // sent to Qdrant (server-side filter), not just assumed — otherwise an
  // unrelated earlier session's entries could leak into a brand-new
  // session's primer just because they're also "recent".
  it("scopes the second query to the most recent entry's own sessionKey, not a hardcoded or reused one", async () => {
    let callCount = 0;
    let secondCallFilter: unknown;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (_collection, params) => {
        callCount++;
        if (callCount === 1) {
          return {
            points: [
              {
                id: "p1",
                payload: {
                  userId: "users/42",
                  sessionKey: "spaces/X:users/42:session-C",
                  summary: "latest",
                  timestamp: "2026-07-25T18:00:00.000Z",
                },
              },
            ],
          };
        }
        secondCallFilter = params.filter;
        return { points: [] };
      },
    };

    await getLastSessionEpisodicSummaries(client, "episodic_memory", { userId: "users/42" });

    expect(secondCallFilter).toEqual({
      must: [
        { key: "userId", match: { value: "users/42" } },
        { key: "sessionKey", match: { value: "spaces/X:users/42:session-C" } },
      ],
    });
  });

  it("returns an empty array without erroring when the client doesn't support scroll", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    expect(await getLastSessionEpisodicSummaries(client, "episodic_memory", { userId: "users/42" })).toEqual([]);
  });

  it("skips malformed payloads in the session-scoped results instead of throwing", async () => {
    let callCount = 0;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            points: [
              {
                id: "p1",
                payload: {
                  userId: "users/42",
                  sessionKey: "spaces/X:users/42",
                  summary: "latest",
                  timestamp: "2026-07-25T18:00:00.000Z",
                },
              },
            ],
          };
        }
        return {
          points: [
            { id: "bad", payload: null },
            {
              id: "good",
              payload: {
                userId: "users/42",
                sessionKey: "spaces/X:users/42",
                summary: "latest",
                timestamp: "2026-07-25T18:00:00.000Z",
              },
            },
          ],
        };
      },
    };

    const results = await getLastSessionEpisodicSummaries(client, "episodic_memory", { userId: "users/42" });

    expect(results).toEqual([
      {
        userId: "users/42",
        sessionKey: "spaces/X:users/42",
        summary: "latest",
        timestamp: "2026-07-25T18:00:00.000Z",
      },
    ]);
  });
});

describe("getEpisodicSummariesBySession", () => {
  const entry = (summary: string, second: number) => ({
    userId: "static:alice",
    sessionKey: "alice:conv-1",
    summary,
    timestamp: `2026-10-12T10:00:0${second}.000Z`,
  });

  it("returns the summaries of one conversation of the person, oldest first", async () => {
    let received: Record<string, unknown> | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (_collection, params) => {
        received = params;
        return { points: [{ id: "a", payload: entry("primo", 1) }, { id: "b", payload: null }, { id: "c", payload: entry("secondo", 2) }] };
      },
    };

    const summaries = await getEpisodicSummariesBySession(client, "episodic_memory", { userId: "static:alice", sessionKey: "alice:conv-1" });

    expect(received).toEqual({
      filter: {
        must: [
          { key: "userId", match: { value: "static:alice" } },
          { key: "sessionKey", match: { value: "alice:conv-1" } },
        ],
      },
      order_by: { key: "timestamp", direction: "asc" },
      limit: 100,
      with_payload: true,
    });
    expect(summaries).toEqual([entry("primo", 1), entry("secondo", 2)]);
  });

  it("is empty when the client has no scroll support", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };
    expect(await getEpisodicSummariesBySession(client, "episodic_memory", { userId: "static:alice", sessionKey: "alice:conv-1" })).toEqual([]);
  });
});
