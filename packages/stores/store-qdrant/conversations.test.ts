import { describe, expect, test } from "bun:test";
import { CONVERSATION_STORE_API_VERSION } from "@mercury-fw/channel-types";
import { createQdrantConversations, qdrantConversations, titlePointId, type QdrantConversationsClient } from "./conversations.ts";

type Point = { id: string | number; vector?: number[]; payload: Record<string, unknown> };

/** A Qdrant fake: collections of points, recording every call; scroll pages by `limit`, numeric offsets. */
function fakeQdrant(collections: Record<string, Point[]> = {}) {
  const calls: Array<[string, string, unknown?]> = [];
  const data = new Map(Object.entries(collections).map(([k, v]) => [k, [...v]]));
  let failing: Error | undefined;
  const fail = () => {
    if (failing) throw failing;
  };
  const client: QdrantConversationsClient = {
    getCollections: async () => (fail(), { collections: [...data.keys()].map((name) => ({ name })) }),
    createCollection: async (name, params) => {
      calls.push(["createCollection", name, params]);
      data.set(name, []);
    },
    createPayloadIndex: async (name, params) => void calls.push(["createPayloadIndex", name, params]),
    count: async (name) => ({ count: data.get(name)?.length ?? 0 }),
    upsert: async (name, params) => {
      calls.push(["upsert", name, params]);
      const list = data.get(name)!;
      for (const p of params.points) {
        const at = list.findIndex((q) => String(q.id) === p.id);
        if (at === -1) list.push(p);
        else list[at] = p;
      }
    },
    scroll: async (name, params) => {
      calls.push(["scroll", name, params]);
      const all = data.get(name) ?? [];
      const start = typeof params.offset === "number" ? params.offset : 0;
      const page = all.slice(start, start + params.limit);
      return { points: page, next_page_offset: start + params.limit < all.length ? start + params.limit : null };
    },
  };
  return { client, calls, data, failWith: (err: Error) => void (failing = err) };
}

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  userId: "static:alice",
  sessionKey: "alice:c1",
  role: "user",
  content: `message ${id}`,
  timestamp: "2026-11-12T10:00:00.000Z",
  ...extra,
});

describe("qdrantConversations", () => {
  test("is a conversation store for this core's contract, built without reaching Qdrant", () => {
    const plugin = qdrantConversations();
    expect(plugin.apiVersion).toBe(CONVERSATION_STORE_API_VERSION);
    expect(plugin.name).toBe("qdrant");
    expect(() => plugin.build({ env: { QDRANT_URL: "http://127.0.0.1:9" }, log: () => {} })).not.toThrow();
  });
});

describe("ready", () => {
  test("creates the messages and titles collections, one placeholder dimension each, with the fields they're read by", async () => {
    const { client, calls } = fakeQdrant();
    await createQdrantConversations(client, {}, () => {}).ready();
    expect(calls).toEqual([
      ["createCollection", "conversation_messages", { vectors: { size: 1, distance: "Dot" } }],
      ["createPayloadIndex", "conversation_messages", { field_name: "userId", field_schema: "keyword" }],
      ["createPayloadIndex", "conversation_messages", { field_name: "sessionKey", field_schema: "keyword" }],
      ["createPayloadIndex", "conversation_messages", { field_name: "timestamp", field_schema: "datetime" }],
      ["createCollection", "conversation_titles", { vectors: { size: 1, distance: "Dot" } }],
      ["createPayloadIndex", "conversation_titles", { field_name: "userId", field_schema: "keyword" }],
      ["createPayloadIndex", "conversation_titles", { field_name: "sessionKey", field_schema: "keyword" }],
    ]);
  });

  test("keeps existing collections, and takes their names from QDRANT_MESSAGES_COLLECTION and QDRANT_TITLES_COLLECTION", async () => {
    const { client, calls } = fakeQdrant({ msgs: [], ttl: [] });
    await createQdrantConversations(client, { QDRANT_MESSAGES_COLLECTION: "msgs", QDRANT_TITLES_COLLECTION: "ttl" }, () => {}).ready();
    expect(calls.filter((c) => c[0] === "createCollection")).toEqual([]);
    expect(new Set(calls.map((c) => c[1]))).toEqual(new Set(["msgs", "ttl"]));
  });

  // #379: the messages lived in the archive's collection, with their vectors;
  // the first start copies them, same ids, nothing embedded again.
  test("copies the archive's points into the messages collection, by id, across pages, and says so", async () => {
    const archive = Array.from({ length: 300 }, (_, i) => ({ id: `a${i}`, vector: [0.1, 0.2], payload: { userId: "u", n: i } }));
    const { client, data } = fakeQdrant({ verbatim_archive: archive });
    const logs: string[] = [];
    await createQdrantConversations(client, {}, (m) => logs.push(m)).ready();
    const copied = data.get("conversation_messages")!;
    expect(copied).toHaveLength(300);
    expect(copied[0]).toEqual({ id: "a0", vector: [1], payload: { userId: "u", n: 0 } });
    expect(logs).toEqual(["copied 300 messages from verbatim_archive into conversation_messages"]);
  });

  test("copies again only what's missing after a copy that stopped halfway, and never once the two match", async () => {
    const archive = [1, 2, 3].map((n) => ({ id: `a${n}`, payload: { n } }));
    const { client, data } = fakeQdrant({ verbatim_archive: archive, conversation_messages: [{ id: "a1", vector: [1], payload: { n: 1 } }] });
    const logs: string[] = [];
    const store = createQdrantConversations(client, {}, (m) => logs.push(m));
    await store.ready();
    expect(data.get("conversation_messages")!.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    await store.ready();
    expect(logs).toHaveLength(1);
  });

  test("copies nothing without an archive, or from an archive QDRANT_VERBATIM_COLLECTION names", async () => {
    const none = fakeQdrant();
    await createQdrantConversations(none.client, {}, () => {}).ready();
    expect(none.data.get("conversation_messages")).toEqual([]);

    const named = fakeQdrant({ old_archive: [{ id: "x", payload: { n: 1 } }] });
    await createQdrantConversations(named.client, { QDRANT_VERBATIM_COLLECTION: "old_archive" }, () => {}).ready();
    expect(named.data.get("conversation_messages")!.map((p) => p.id)).toEqual(["x"]);
  });
});

describe("messages", () => {
  test("append keeps the message as a point: its id the point's, the rest its payload", async () => {
    const { client, calls } = fakeQdrant({ conversation_messages: [] });
    await createQdrantConversations(client, {}, () => {}).append(message("6f1c0d2e-0000-4000-8000-000000000001"));
    const { id: _id, ...payload } = message("6f1c0d2e-0000-4000-8000-000000000001");
    expect(calls).toEqual([["upsert", "conversation_messages", { points: [{ id: "6f1c0d2e-0000-4000-8000-000000000001", vector: [1], payload }] }]]);
  });

  test("reads one conversation of one person in the asked order, paged, each message with its id", async () => {
    const { client, calls } = fakeQdrant({
      conversation_messages: [
        { id: "m1", payload: { userId: "static:alice", sessionKey: "alice:c1", timestamp: "t1" } },
        { id: "m2", payload: { userId: "static:alice", sessionKey: "alice:c1", timestamp: "t2" } },
      ],
    });
    const store = createQdrantConversations(client, {}, () => {});
    const page = await store.messages({ userId: "static:alice", sessionKey: "alice:c1", order: "desc", limit: 1 });
    expect(page).toEqual({ messages: [{ id: "m1", userId: "static:alice", sessionKey: "alice:c1", timestamp: "t1" }], next: "1" });
    await store.messages({ userId: "static:alice", sessionKey: "alice:c1", order: "asc", limit: 1, cursor: page.next! });
    expect(calls.map((c) => c[2])).toEqual([
      {
        filter: { must: [{ key: "userId", match: { value: "static:alice" } }, { key: "sessionKey", match: { value: "alice:c1" } }] },
        order_by: { key: "timestamp", direction: "desc" },
        limit: 1,
        with_payload: true,
      },
      {
        filter: { must: [{ key: "userId", match: { value: "static:alice" } }, { key: "sessionKey", match: { value: "alice:c1" } }] },
        order_by: { key: "timestamp", direction: "asc" },
        limit: 1,
        offset: 1,
        with_payload: true,
      },
    ]);
  });

  test("a point id cursor goes back as it is, and the last page has no next", async () => {
    const { client, calls } = fakeQdrant({ conversation_messages: [] });
    const page = await createQdrantConversations(client, {}, () => {}).messages({
      userId: "u",
      sessionKey: "s",
      order: "asc",
      limit: 5,
      cursor: "6f1c0d2e-0000-4000-8000-000000000001",
    });
    expect(page).toEqual({ messages: [] });
    expect((calls[0]![2] as { offset: unknown }).offset).toBe("6f1c0d2e-0000-4000-8000-000000000001");
  });

  test("recent reads the person's newest messages across conversations", async () => {
    const { client, calls } = fakeQdrant({ conversation_messages: [{ id: "m1", payload: { userId: "u", sessionKey: "a", timestamp: "t" } }] });
    expect(await createQdrantConversations(client, {}, () => {}).recent({ userId: "u", limit: 500 })).toEqual([
      { id: "m1", userId: "u", sessionKey: "a", timestamp: "t" },
    ]);
    expect(calls[0]![2]).toEqual({
      filter: { must: [{ key: "userId", match: { value: "u" } }] },
      order_by: { key: "timestamp", direction: "desc" },
      limit: 500,
      with_payload: true,
    });
  });
});

describe("titles", () => {
  const title = { userId: "u1", sessionKey: "u1:a", title: "Sprint", source: "person", updatedAt: "2026-11-12T10:00:00.000Z" };

  test("setTitle replaces the point of that person's conversation, its id as titles always had it", async () => {
    const { client, calls } = fakeQdrant({ conversation_titles: [] });
    await createQdrantConversations(client, {}, () => {}).setTitle(title);
    expect(calls).toEqual([["upsert", "conversation_titles", { points: [{ id: titlePointId("u1", "u1:a"), vector: [1], payload: title }] }]]);
  });

  test("titles reads the person's among the conversations asked, and none for none asked", async () => {
    const { client, calls } = fakeQdrant({ conversation_titles: [{ id: titlePointId("u1", "u1:a"), payload: title }] });
    const store = createQdrantConversations(client, {}, () => {});
    expect(await store.titles({ userId: "u1", sessionKeys: ["u1:a", "u1:b"] })).toEqual([title]);
    expect(calls[0]![2]).toEqual({
      filter: { must: [{ key: "userId", match: { value: "u1" } }, { key: "sessionKey", match: { any: ["u1:a", "u1:b"] } }] },
      limit: 2,
      with_payload: true,
    });
    expect(await store.titles({ userId: "u1", sessionKeys: [] })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("titlePointId is a name-based UUID of the person and the conversation, stable and distinct", () => {
    expect(titlePointId("google:1", "google:1:abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(titlePointId("google:1", "google:1:abc")).toBe(titlePointId("google:1", "google:1:abc"));
    expect(titlePointId("a:b", "c")).not.toBe(titlePointId("a", "b:c"));
  });
});

describe("health", () => {
  test("is ok when Qdrant lists its collections, and says why not otherwise", async () => {
    const up = fakeQdrant();
    expect(await createQdrantConversations(up.client, {}, () => {}).health()).toEqual({ ok: true });
    const down = fakeQdrant();
    down.failWith(new Error("ECONNREFUSED"));
    expect(await createQdrantConversations(down.client, {}, () => {}).health()).toEqual({ ok: false, detail: "ECONNREFUSED" });
  });
});
