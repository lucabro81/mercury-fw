import { describe, it, expect } from "bun:test";
import {
  ensureVerbatimCollection,
  appendVerbatimMessage,
  searchVerbatim,
  listVerbatimBySession,
  listVerbatimSessions,
} from "./verbatim-archive-store.ts";
import type { QdrantClientLike } from "./episodic-store.ts";

describe("ensureVerbatimCollection", () => {
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

    await ensureVerbatimCollection(client, "verbatim_archive", 768);

    expect(created).toEqual({
      name: "verbatim_archive",
      params: { vectors: { size: 768, distance: "Cosine" } },
    });
  });

  it("does not recreate a collection that already exists", async () => {
    let createCalls = 0;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [{ name: "verbatim_archive" }] }),
      createCollection: async () => {
        createCalls++;
        return {};
      },
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    await ensureVerbatimCollection(client, "verbatim_archive", 768);

    expect(createCalls).toBe(0);
  });

  // searchVerbatim filters by userId; listVerbatimBySession filters by
  // sessionKey and orders by timestamp. Each needs its own payload index
  // (keyword for the equality filters, datetime for the order_by), or the
  // query fails with an HTTP 400. Ensured unconditionally (not only on fresh
  // creation) so a collection made before this self-heals — same reasoning as
  // episodic-store's index guard.
  it("creates the userId, sessionKey and timestamp payload indexes when creating a new collection", async () => {
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

    await ensureVerbatimCollection(client, "verbatim_archive", 768);

    expect(indexCalls).toEqual([
      { name: "verbatim_archive", params: { field_name: "userId", field_schema: "keyword" } },
      { name: "verbatim_archive", params: { field_name: "sessionKey", field_schema: "keyword" } },
      { name: "verbatim_archive", params: { field_name: "timestamp", field_schema: "datetime" } },
    ]);
  });

  it("creates the payload indexes even when the collection already exists", async () => {
    const indexCalls: Array<{ name: string; params: unknown }> = [];
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [{ name: "verbatim_archive" }] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      createPayloadIndex: async (name, params) => {
        indexCalls.push({ name, params });
        return {};
      },
    };

    await ensureVerbatimCollection(client, "verbatim_archive", 768);

    expect(indexCalls).toHaveLength(3);
  });

  it("does not throw when the client doesn't support createPayloadIndex", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    await expect(ensureVerbatimCollection(client, "verbatim_archive", 768)).resolves.toBeUndefined();
  });
});

describe("appendVerbatimMessage", () => {
  it("embeds the message content and upserts a point with the full verbatim payload", async () => {
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

    await appendVerbatimMessage(client, "verbatim_archive", embed, {
      userId: "users/42",
      sessionKey: "spaces/X:users/42",
      role: "user",
      content: "come sta KAN-1?",
      timestamp: "2026-09-22T12:00:00.000Z",
    });

    expect(upserted?.collection).toBe("verbatim_archive");
    expect(upserted?.points).toHaveLength(1);
    const point = upserted!.points[0] as { id: string; vector: number[]; payload: Record<string, unknown> };
    expect(point.vector).toEqual(["come sta KAN-1?".length, 0, 0]);
    expect(point.payload).toEqual({
      userId: "users/42",
      sessionKey: "spaces/X:users/42",
      role: "user",
      content: "come sta KAN-1?",
      timestamp: "2026-09-22T12:00:00.000Z",
    });
    expect(typeof point.id).toBe("string");
  });

  it("embeds the assistant role's content just the same", async () => {
    let payload: Record<string, unknown> | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async (_collection, params) => {
        payload = (params.points[0] as { payload: Record<string, unknown> }).payload;
        return {};
      },
      query: async () => ({ points: [] }),
    };
    const embed = async () => [1, 2, 3];

    await appendVerbatimMessage(client, "verbatim_archive", embed, {
      userId: "users/42",
      sessionKey: "terminal",
      role: "assistant",
      content: "KAN-1 è In Progress.",
      timestamp: "2026-09-22T12:00:05.000Z",
    });

    expect(payload?.role).toBe("assistant");
    expect(payload?.content).toBe("KAN-1 è In Progress.");
  });
});

describe("searchVerbatim", () => {
  it("embeds queryText, searches scoped to userId, and maps payloads back to VerbatimMessage", async () => {
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
              score: 0.88,
              payload: {
                userId: "users/42",
                sessionKey: "spaces/X:users/42",
                role: "user",
                content: "la settimana scorsa dicevamo di KAN-1",
                timestamp: "2026-09-15T09:00:00.000Z",
              },
            },
          ],
        };
      },
    };
    const embed = async (text: string) => [text.length, 0, 0];

    const results = await searchVerbatim(client, "verbatim_archive", embed, {
      userId: "users/42",
      queryText: "cosa dicevamo di KAN-1",
    });

    expect(receivedArgs?.collection).toBe("verbatim_archive");
    expect(receivedArgs?.params).toEqual({
      query: ["cosa dicevamo di KAN-1".length, 0, 0],
      filter: { must: [{ key: "userId", match: { value: "users/42" } }] },
      limit: 5,
      with_payload: true,
    });
    expect(results).toEqual([
      {
        userId: "users/42",
        sessionKey: "spaces/X:users/42",
        role: "user",
        content: "la settimana scorsa dicevamo di KAN-1",
        timestamp: "2026-09-15T09:00:00.000Z",
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

    await searchVerbatim(client, "verbatim_archive", embed, { userId: "users/42", queryText: "x", limit: 10 });

    expect(receivedLimit).toBe(10);
  });

  // Qdrant allows a null payload on a point, and a malformed one could
  // exist from an older schema — skip rather than crash or return a
  // malformed VerbatimMessage.
  it("skips results with a missing or malformed payload instead of throwing", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({
        points: [
          { id: "p1", score: 0.9, payload: null },
          { id: "p2", score: 0.8, payload: { content: 42 } }, // wrong type
          { id: "p3", score: 0.7, payload: { userId: "users/42", sessionKey: "t", role: "captain", content: "hi", timestamp: "2026-09-15T09:00:00.000Z" } }, // invalid role
          {
            id: "p4",
            score: 0.6,
            payload: {
              userId: "users/42",
              sessionKey: "terminal",
              role: "assistant",
              content: "valid one",
              timestamp: "2026-09-15T09:00:00.000Z",
            },
          },
        ],
      }),
    };
    const embed = async () => [0, 0, 0];

    const results = await searchVerbatim(client, "verbatim_archive", embed, { userId: "users/42", queryText: "x" });

    expect(results).toEqual([
      {
        userId: "users/42",
        sessionKey: "terminal",
        role: "assistant",
        content: "valid one",
        timestamp: "2026-09-15T09:00:00.000Z",
      },
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

    expect(await searchVerbatim(client, "verbatim_archive", embed, { userId: "users/42", queryText: "x" })).toEqual([]);
  });
});

describe("listVerbatimBySession", () => {
  const msg = (sessionKey: string, role: "user" | "assistant", content: string, timestamp: string) => ({
    userId: "u",
    sessionKey,
    role,
    content,
    timestamp,
  });

  it("scrolls the session's messages filtered by the person and the sessionKey, ordered by timestamp ascending", async () => {
    let received: { collection: string; params: Record<string, unknown> } | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (collection, params) => {
        received = { collection, params };
        return {
          points: [
            { id: "p1", payload: msg("conv-1", "user", "ciao", "2026-09-22T12:00:00.000Z") },
            { id: "p2", payload: msg("conv-1", "assistant", "ciao a te", "2026-09-22T12:00:01.000Z") },
          ],
          next_page_offset: "cursor-2",
        };
      },
    };

    const result = await listVerbatimBySession(client, "verbatim_archive", { userId: "static:alice", sessionKey: "conv-1", limit: 50 });

    expect(received?.collection).toBe("verbatim_archive");
    expect(received?.params).toEqual({
      filter: {
        must: [
          { key: "userId", match: { value: "static:alice" } },
          { key: "sessionKey", match: { value: "conv-1" } },
        ],
      },
      order_by: { key: "timestamp", direction: "asc" },
      limit: 50,
      offset: undefined,
      with_payload: true,
    });
    expect(result).toEqual({
      messages: [
        msg("conv-1", "user", "ciao", "2026-09-22T12:00:00.000Z"),
        msg("conv-1", "assistant", "ciao a te", "2026-09-22T12:00:01.000Z"),
      ],
      nextOffset: "cursor-2",
    });
  });

  it("forwards the pagination offset and reports null when there is no next page", async () => {
    let receivedOffset: unknown;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (_collection, params) => {
        receivedOffset = params.offset;
        return { points: [] };
      },
    };

    const result = await listVerbatimBySession(client, "verbatim_archive", { userId: "static:alice",
      sessionKey: "conv-1",
      limit: 10,
      offset: "cursor-1",
    });

    expect(receivedOffset).toBe("cursor-1");
    expect(result).toEqual({ messages: [], nextOffset: null });
  });

  it("skips malformed points instead of returning them", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async () => ({
        points: [
          { id: "p1", payload: null },
          { id: "p2", payload: { content: 42 } },
          { id: "p3", payload: msg("conv-1", "assistant", "valid", "2026-09-22T12:00:02.000Z") },
        ],
      }),
    };

    const result = await listVerbatimBySession(client, "verbatim_archive", { userId: "static:alice", sessionKey: "conv-1", limit: 50 });

    expect(result.messages).toEqual([msg("conv-1", "assistant", "valid", "2026-09-22T12:00:02.000Z")]);
  });

  it("returns empty when the client has no scroll support", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    expect(await listVerbatimBySession(client, "verbatim_archive", { userId: "static:alice", sessionKey: "conv-1", limit: 50 })).toEqual({
      messages: [],
      nextOffset: null,
    });
  });
});

describe("listVerbatimSessions", () => {
  const msg = (sessionKey: string, content: string, timestamp: string) => ({
    userId: "u",
    sessionKey,
    role: "user" as const,
    content,
    timestamp,
  });

  it("scrolls the person's messages newest-first and dedups by sessionKey, keeping each conversation's most recent message", async () => {
    let received: { params: Record<string, unknown> } | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (_collection, params) => {
        received = { params };
        return {
          points: [
            { id: "p1", payload: msg("conv-b", "latest in b", "2026-09-24T12:00:03.000Z") },
            { id: "p2", payload: msg("conv-a", "latest in a", "2026-09-24T12:00:02.000Z") },
            { id: "p3", payload: msg("conv-b", "older in b", "2026-09-24T12:00:01.000Z") },
            { id: "p4", payload: msg("conv-a", "older in a", "2026-09-24T12:00:00.000Z") },
          ],
        };
      },
    };

    const result = await listVerbatimSessions(client, "verbatim_archive", { userId: "static:alice", limit: 10 });

    expect(received?.params).toEqual({
      filter: { must: [{ key: "userId", match: { value: "static:alice" } }] },
      order_by: { key: "timestamp", direction: "desc" },
      limit: 500,
      with_payload: true,
    });
    expect(result).toEqual({
      conversations: [
        { sessionKey: "conv-b", lastTimestamp: "2026-09-24T12:00:03.000Z", preview: "latest in b" },
        { sessionKey: "conv-a", lastTimestamp: "2026-09-24T12:00:02.000Z", preview: "latest in a" },
      ],
    });
  });

  it("caps the number of returned conversations at limit", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async () => ({
        points: [
          { id: "p1", payload: msg("conv-a", "a", "2026-09-24T12:00:03.000Z") },
          { id: "p2", payload: msg("conv-b", "b", "2026-09-24T12:00:02.000Z") },
          { id: "p3", payload: msg("conv-c", "c", "2026-09-24T12:00:01.000Z") },
        ],
      }),
    };

    const result = await listVerbatimSessions(client, "verbatim_archive", { userId: "static:alice", limit: 2 });

    expect(result.conversations.map((c) => c.sessionKey)).toEqual(["conv-a", "conv-b"]);
  });

  it("returns empty when the client has no scroll support", async () => {
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
    };

    expect(await listVerbatimSessions(client, "verbatim_archive", { userId: "static:alice", limit: 10 })).toEqual({ conversations: [] });
  });
});
