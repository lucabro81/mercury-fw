import { describe, it, expect } from "bun:test";
import {
  ensureVerbatimCollection,
  appendVerbatimMessage,
  searchVerbatim,
  listVerbatimBySession,
  listVerbatimSessions,
  listVerbatimTail,
  shownText,
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

describe("listVerbatimTail", () => {
  const msg = (role: "user" | "assistant", content: string, second: number) => ({
    userId: "static:alice",
    sessionKey: "alice:conv-1",
    role,
    content,
    timestamp: `2026-10-12T10:00:${String(second).padStart(2, "0")}.000Z`,
  });

  /** A client whose scroll hands back `newestFirst` (already newest first, as Qdrant would), recording the request. */
  function clientWith(newestFirst: ReturnType<typeof msg>[], received: { params?: Record<string, unknown> } = {}): QdrantClientLike {
    return {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points: [] }),
      scroll: async (_collection, params) => {
        received.params = params;
        return { points: newestFirst.map((payload, i) => ({ id: `p${i}`, payload })) };
      },
    };
  }

  it("asks for the person's conversation newest first, and returns it in chronological order", async () => {
    const received: { params?: Record<string, unknown> } = {};
    const client = clientWith([msg("assistant", "verde", 3), msg("user", "colore?", 2), msg("assistant", "ok", 1), msg("user", "mi piace il verde", 0)], received);

    const tail = await listVerbatimTail(client, "verbatim_archive", { userId: "static:alice", sessionKey: "alice:conv-1", maxChars: 1000 });

    expect(received.params).toEqual({
      filter: {
        must: [
          { key: "userId", match: { value: "static:alice" } },
          { key: "sessionKey", match: { value: "alice:conv-1" } },
        ],
      },
      order_by: { key: "timestamp", direction: "desc" },
      limit: 200,
      with_payload: true,
    });
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
    const client = clientWith([msg("assistant", "dddd", 3), msg("user", "cccc", 2), msg("assistant", "bb", 1), msg("user", "aaaa", 0)]);

    const tail = await listVerbatimTail(client, "verbatim_archive", { userId: "static:alice", sessionKey: "alice:conv-1", maxChars: 10 });

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

  it("is incomplete when the archive holds more than one scroll page of the conversation", async () => {
    const many = Array.from({ length: 200 }, (_, i) => msg(i % 2 === 0 ? "assistant" : "user", "x", 59));
    const tail = await listVerbatimTail(clientWith(many), "verbatim_archive", { userId: "static:alice", sessionKey: "alice:conv-1", maxChars: 10_000 });
    expect(tail.complete).toBe(false);
    expect(tail.messages[0]?.role).toBe("user");
  });

  it("is empty when even the newest message doesn't fit, or nothing is archived", async () => {
    expect(await listVerbatimTail(clientWith([msg("assistant", "troppo lungo", 1), msg("user", "a", 0)]), "verbatim_archive", { userId: "static:alice", sessionKey: "alice:conv-1", maxChars: 5 })).toEqual({
      messages: [],
      complete: false,
      leftOutAt: "2026-10-12T10:00:01.000Z",
    });
    expect(await listVerbatimTail(clientWith([]), "verbatim_archive", { userId: "static:alice", sessionKey: "alice:conv-1", maxChars: 5 })).toEqual({ messages: [], complete: true });
  });

  it("skips malformed points", async () => {
    const client: QdrantClientLike = {
      ...clientWith([]),
      scroll: async () => ({ points: [{ id: "p1", payload: null }, { id: "p2", payload: msg("user", "ciao", 0) }] }),
    };
    expect(await listVerbatimTail(client, "verbatim_archive", { userId: "static:alice", sessionKey: "alice:conv-1", maxChars: 100 })).toEqual({
      messages: [{ role: "user", content: "ciao", timestamp: "2026-10-12T10:00:00.000Z" }],
      complete: true,
    });
  });

  it("is empty when the client has no scroll support", async () => {
    const { scroll: _scroll, ...noScroll } = clientWith([]);
    expect(await listVerbatimTail(noScroll, "verbatim_archive", { userId: "static:alice", sessionKey: "alice:conv-1", maxChars: 100 })).toEqual({
      messages: [],
      complete: false,
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

  /** A client whose scroll and query hand back `payloads` as points. */
  function clientWith(payloads: Array<Record<string, unknown>>): QdrantClientLike {
    const points = payloads.map((payload, i) => ({ id: `p${i}`, score: 1, payload }));
    return {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points }),
      scroll: async () => ({ points, next_page_offset: null }),
    };
  }

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
      let point: { vector: number[]; payload: Record<string, unknown> } | undefined;
      const client: QdrantClientLike = {
        ...clientWith([]),
        upsert: async (_collection, params) => {
          point = params.points[0] as typeof point;
          return {};
        },
      };
      const embedded: string[] = [];
      const embed = async (text: string) => {
        embedded.push(text);
        return [1];
      };

      await appendVerbatimMessage(client, "verbatim_archive", embed, answer);

      expect(point?.payload).toEqual(answer);
      expect(embedded).toEqual(["Ecco le tue issue:"]);
    });

    it("embeds what was shown when the answer is empty", async () => {
      const embedded: string[] = [];
      const embed = async (text: string) => {
        embedded.push(text);
        return [1];
      };

      await appendVerbatimMessage(clientWith([]), "verbatim_archive", embed, { ...answer, content: "" });

      expect(embedded).toEqual([LIST]);
    });
  });

  it("listVerbatimBySession serves each message as it was shown, without a separate displays field", async () => {
    const result = await listVerbatimBySession(clientWith([question, answer]), "verbatim_archive", {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });

    const { displays: _displays, ...rest } = answer;
    expect(result.messages).toEqual([question, { ...rest, content: `Ecco le tue issue:\n\n${LIST}` }]);
  });

  it("listVerbatimSessions previews what was shown", async () => {
    const result = await listVerbatimSessions(clientWith([{ ...answer, content: "" }]), "verbatim_archive", {
      userId: "static:alice",
      limit: 10,
    });

    expect(result.conversations).toEqual([
      { sessionKey: "conv-1", lastTimestamp: answer.timestamp, preview: "KAN-1 [In corso] Login\nhttps://example.atlassian.net/browse/KAN-1" },
    ]);
  });

  it("listVerbatimTail, what goes back to the model, keeps the answer only", async () => {
    const tail = await listVerbatimTail(clientWith([answer, question]), "verbatim_archive", {
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
    const results = await searchVerbatim(clientWith([answer]), "verbatim_archive", async () => [1], {
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
    const tail = await listVerbatimTail(clientWith([{ ...answer, content: "" }, question]), "verbatim_archive", {
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
    const tail = await listVerbatimTail(clientWith([{ ...answer, content: " \n " }, question]), "verbatim_archive", {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });
    expect(tail.messages).toEqual([{ role: "user", content: "Quali issue ho?", timestamp: question.timestamp }]);

    const embedded: string[] = [];
    await appendVerbatimMessage(clientWith([]), "verbatim_archive", async (text) => (embedded.push(text), [1]), {
      ...answer,
      content: " ",
    });
    expect(embedded).toEqual([` \n\n${LIST}`]);
  });

  it("searchVerbatim leaves out an answer that was only displays", async () => {
    const results = await searchVerbatim(
      clientWith([{ ...answer, content: "" }, question]),
      "verbatim_archive",
      async () => [1],
      { userId: "static:alice", queryText: "issue" },
    );

    expect(results).toEqual([question]);
  });

  it("listVerbatimSessions cuts the preview of what was shown at 120 characters", async () => {
    const long = "x".repeat(200);
    const result = await listVerbatimSessions(clientWith([{ ...answer, content: "Ecco:", displays: [long] }]), "verbatim_archive", {
      userId: "static:alice",
      limit: 10,
    });

    expect(result.conversations[0]?.preview).toBe(`${`Ecco:\n\n${long}`.slice(0, 120)}…`);
  });

  it("reads a message without displays, archived before them, as it was", async () => {
    const result = await listVerbatimBySession(clientWith([question]), "verbatim_archive", {
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

  function clientWith(payloads: Array<Record<string, unknown>>): QdrantClientLike {
    const points = payloads.map((payload, i) => ({ id: `p${i}`, score: 1, payload }));
    return {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async () => ({ points }),
      scroll: async () => ({ points, next_page_offset: null }),
    };
  }

  it("keeps the calls in the payload", async () => {
    let payload: Record<string, unknown> | undefined;
    const client: QdrantClientLike = {
      ...clientWith([]),
      upsert: async (_collection, params) => {
        payload = (params.points[0] as { payload: Record<string, unknown> }).payload;
        return {};
      },
    };
    await appendVerbatimMessage(client, "verbatim_archive", async () => [1], answer);
    expect(payload).toEqual(answer);
  });

  it("listVerbatimTail, what goes back to the model, brings the calls back", async () => {
    const tail = await listVerbatimTail(clientWith([answer, question]), "verbatim_archive", {
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
    const whole = await listVerbatimTail(clientWith([answer, question]), "verbatim_archive", { ...query, maxChars: fits });
    expect(whole.messages).toHaveLength(2);
    const short = await listVerbatimTail(clientWith([answer, question]), "verbatim_archive", { ...query, maxChars: fits - 1 });
    expect(short.messages).toEqual([]);
  });

  it("listVerbatimBySession, what a UI renders, leaves the calls out", async () => {
    const result = await listVerbatimBySession(clientWith([question, answer]), "verbatim_archive", {
      userId: "static:alice",
      sessionKey: "conv-1",
      limit: 50,
    });
    const { calls: _calls, ...shown } = answer;
    expect(result.messages).toEqual([question, shown]);
  });

  it("searchVerbatim, what recall_verbatim hands the model, leaves the calls out", async () => {
    const results = await searchVerbatim(clientWith([answer]), "verbatim_archive", async () => [1], {
      userId: "static:alice",
      queryText: "issue",
    });
    const { calls: _calls, ...said } = answer;
    expect(results).toEqual([said]);
  });

  it("skips a point whose calls aren't a list of calls", async () => {
    const tail = await listVerbatimTail(clientWith([{ ...answer, calls: "nope" }, question]), "verbatim_archive", {
      userId: "static:alice",
      sessionKey: "conv-1",
      maxChars: 10_000,
    });
    expect(tail.messages).toEqual([{ role: "user", content: "Quali issue ho?", timestamp: question.timestamp }]);
  });
});
