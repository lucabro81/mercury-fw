import { describe, expect, test } from "bun:test";
import { VECTOR_INDEX_API_VERSION } from "@mercury-fw/channel-types";
import { createQdrantIndex, qdrantIndex, type QdrantIndexClient } from "./index.ts";

type Call = [string, ...unknown[]];

/** A Qdrant client recording every call, answering with what each test gives it. */
function fakeClient(answers: {
  collections?: string[];
  query?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> | null }>;
  scroll?: { points: Array<{ id: string | number; payload?: Record<string, unknown> | null }>; next_page_offset?: unknown };
  fail?: Error;
} = {}) {
  const calls: Call[] = [];
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    if (answers.fail) throw answers.fail;
    return undefined;
  };
  const client: QdrantIndexClient = {
    getCollections: async () => {
      calls.push(["getCollections"]);
      if (answers.fail) throw answers.fail;
      return { collections: (answers.collections ?? []).map((name) => ({ name })) };
    },
    createCollection: record("createCollection") as QdrantIndexClient["createCollection"],
    createPayloadIndex: record("createPayloadIndex") as QdrantIndexClient["createPayloadIndex"],
    upsert: record("upsert") as QdrantIndexClient["upsert"],
    setPayload: record("setPayload") as QdrantIndexClient["setPayload"],
    query: async (...args) => {
      calls.push(["query", ...args]);
      return { points: answers.query ?? [] };
    },
    scroll: async (...args) => {
      calls.push(["scroll", ...args]);
      return (answers.scroll ?? { points: [] }) as Awaited<ReturnType<QdrantIndexClient["scroll"]>>;
    },
  };
  return { client, calls };
}

describe("qdrantIndex", () => {
  test("is a vector index for this core's contract", () => {
    const plugin = qdrantIndex();
    expect(plugin.apiVersion).toBe(VECTOR_INDEX_API_VERSION);
    expect(plugin.name).toBe("qdrant");
  });

  test("builds from QDRANT_URL without reaching Qdrant", () => {
    expect(() => qdrantIndex().build({ env: { QDRANT_URL: "http://127.0.0.1:9" }, log: () => {} })).not.toThrow();
  });
});

describe("createQdrantIndex", () => {
  test("ensure creates a missing space as a cosine collection of its dimensions, with keyword and datetime indexes", async () => {
    const { client, calls } = fakeClient({ collections: [] });
    await createQdrantIndex(client, {}).ensure("episodic_memory", { dimensions: 768, keys: ["userId", "sessionKey"], ordered: ["timestamp"] });
    expect(calls).toEqual([
      ["getCollections"],
      ["createCollection", "episodic_memory", { vectors: { size: 768, distance: "Cosine" } }],
      ["createPayloadIndex", "episodic_memory", { field_name: "userId", field_schema: "keyword" }],
      ["createPayloadIndex", "episodic_memory", { field_name: "sessionKey", field_schema: "keyword" }],
      ["createPayloadIndex", "episodic_memory", { field_name: "timestamp", field_schema: "datetime" }],
    ]);
  });

  test("ensure leaves an existing collection as it is and still makes sure of its indexes", async () => {
    const { client, calls } = fakeClient({ collections: ["semantic_facts"] });
    await createQdrantIndex(client, {}).ensure("semantic_facts", { dimensions: 768, keys: ["userId"] });
    expect(calls).toEqual([
      ["getCollections"],
      ["createPayloadIndex", "semantic_facts", { field_name: "userId", field_schema: "keyword" }],
    ]);
  });

  test("a space is the collection its QDRANT_*_COLLECTION variable names, itself otherwise", async () => {
    const env = {
      QDRANT_EPISODIC_COLLECTION: "ep",
      QDRANT_SEMANTIC_FACTS_COLLECTION: "facts",
      QDRANT_TOOL_CORRECTIONS_COLLECTION: "fixes",
      QDRANT_VERBATIM_COLLECTION: "archive",
    };
    const { client, calls } = fakeClient();
    const index = createQdrantIndex(client, env);
    for (const space of ["episodic_memory", "semantic_facts", "tool_corrections", "verbatim_archive", "other"]) {
      await index.upsert(space, []);
    }
    expect(calls.map((c) => c[1])).toEqual(["ep", "facts", "fixes", "archive", "other"]);
  });

  test("upsert writes the points as they are", async () => {
    const { client, calls } = fakeClient();
    const point = { id: "6f1c0d2e-0000-4000-8000-000000000001", vector: [0.1, 0.2], payload: { userId: "u" } };
    await createQdrantIndex(client, {}).upsert("s", [point]);
    expect(calls).toEqual([["upsert", "s", { points: [point] }]]);
  });

  test("query filters on every where field, and returns ids as strings and payloads never null", async () => {
    const { client, calls } = fakeClient({
      query: [
        { id: "a", score: 0.9, payload: { topic: "x" } },
        { id: 7, score: 0.5, payload: null },
      ],
    });
    const results = await createQdrantIndex(client, {}).query("s", { vector: [1, 0], where: { userId: "u", tool: "jira" }, limit: 5 });
    expect(calls).toEqual([
      [
        "query",
        "s",
        {
          query: [1, 0],
          filter: { must: [{ key: "userId", match: { value: "u" } }, { key: "tool", match: { value: "jira" } }] },
          limit: 5,
          with_payload: true,
        },
      ],
    ]);
    expect(results).toEqual([
      { id: "a", score: 0.9, payload: { topic: "x" } },
      { id: "7", score: 0.5, payload: {} },
    ]);
  });

  test("query with no where sends no filter", async () => {
    const { client, calls } = fakeClient();
    await createQdrantIndex(client, {}).query("s", { vector: [1], limit: 1 });
    expect(calls[0]![2]).toEqual({ query: [1], limit: 1, with_payload: true });
  });

  test("scroll filters, orders and pages, its cursor the point id Qdrant gives as next", async () => {
    const { client, calls } = fakeClient({
      scroll: { points: [{ id: "p1", payload: { a: 1 } }], next_page_offset: "6f1c0d2e-0000-4000-8000-000000000002" },
    });
    const page = await createQdrantIndex(client, {}).scroll("s", {
      where: { userId: "u" },
      orderBy: { key: "timestamp", direction: "desc" },
      limit: 2,
      cursor: "6f1c0d2e-0000-4000-8000-000000000001",
    });
    expect(calls).toEqual([
      [
        "scroll",
        "s",
        {
          filter: { must: [{ key: "userId", match: { value: "u" } }] },
          order_by: { key: "timestamp", direction: "desc" },
          limit: 2,
          offset: "6f1c0d2e-0000-4000-8000-000000000001",
          with_payload: true,
        },
      ],
    ]);
    expect(page).toEqual({ points: [{ id: "p1", payload: { a: 1 } }], next: "6f1c0d2e-0000-4000-8000-000000000002" });
  });

  test("a numeric next offset comes back as a cursor that goes back as the same number", async () => {
    const { client, calls } = fakeClient({ scroll: { points: [], next_page_offset: 42 } });
    const index = createQdrantIndex(client, {});
    const { next } = await index.scroll("s", { limit: 1 });
    expect(next).toBe("42");
    await index.scroll("s", { limit: 1, cursor: next! });
    expect((calls[1]![2] as { offset: unknown }).offset).toBe(42);
  });

  test("the last page has no next, and a bare scroll sends only its limit", async () => {
    const { client, calls } = fakeClient({ scroll: { points: [{ id: 3, payload: null }], next_page_offset: null } });
    expect(await createQdrantIndex(client, {}).scroll("s", { limit: 10 })).toEqual({ points: [{ id: "3", payload: {} }] });
    expect(calls[0]![2]).toEqual({ limit: 10, with_payload: true });
  });

  test("setPayload sets the fields on what where selects, waiting for it", async () => {
    const { client, calls } = fakeClient();
    await createQdrantIndex(client, {}).setPayload("s", { where: { userId: "old" }, payload: { userId: "static:old" } });
    expect(calls).toEqual([
      ["setPayload", "s", { payload: { userId: "static:old" }, filter: { must: [{ key: "userId", match: { value: "old" } }] }, wait: true }],
    ]);
  });

  test("health is ok when Qdrant lists its collections, and says why not otherwise", async () => {
    expect(await createQdrantIndex(fakeClient().client, {}).health()).toEqual({ ok: true });
    expect(await createQdrantIndex(fakeClient({ fail: new Error("ECONNREFUSED") }).client, {}).health()).toEqual({
      ok: false,
      detail: "ECONNREFUSED",
    });
  });
});
