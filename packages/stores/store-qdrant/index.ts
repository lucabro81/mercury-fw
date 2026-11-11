/**
 * Qdrant as Mercury's vector index and conversation store. `qdrantIndex()` is
 * what an app declares as `vectorIndex` in `mercury.config.ts`, and
 * `qdrantConversations()` (`./conversations.ts`) what it declares as
 * `conversationStore`. The index: Each space is a Qdrant collection of
 * cosine vectors, its keyword fields and its ordered (datetime) fields
 * indexed, as the core's `ensure` asks. The core computes the vectors; this
 * package only stores and finds them.
 *
 * Qdrant is reached at `QDRANT_URL` (`http://qdrant:6333`, the compose
 * service, when it's not set). A space is the collection of the same name,
 * except where an app named it otherwise with the variables older versions
 * of the core read (`QDRANT_EPISODIC_COLLECTION`, …), so an instance keeps
 * its collections as they are.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  VECTOR_INDEX_API_VERSION,
  type VectorIndex,
  type VectorIndexPlugin,
  type VectorWhere,
} from "@mercury-fw/channel-types";

type QdrantFilter = { must: Array<{ key: string; match: { value: string } }> };
type QdrantOffset = string | number | Record<string, unknown> | null | undefined;
type QdrantPayload = Record<string, unknown> | null | undefined;

/** The slice of `@qdrant/js-client-rest`'s client the index uses. */
export type QdrantIndexClient = {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(name: string, params: { vectors: { size: number; distance: "Cosine" } }): Promise<unknown>;
  createPayloadIndex(name: string, params: { field_name: string; field_schema: "keyword" | "datetime" }): Promise<unknown>;
  upsert(name: string, params: { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> }): Promise<unknown>;
  query(
    name: string,
    params: { query: number[]; filter?: QdrantFilter; limit: number; with_payload: true },
  ): Promise<{ points: Array<{ id: string | number; score: number; payload?: QdrantPayload }> }>;
  scroll(
    name: string,
    params: {
      filter?: QdrantFilter;
      order_by?: { key: string; direction: "asc" | "desc" };
      limit: number;
      offset?: QdrantOffset;
      with_payload: true;
    },
  ): Promise<{ points: Array<{ id: string | number; payload?: QdrantPayload }>; next_page_offset?: QdrantOffset }>;
  setPayload(name: string, params: { payload: Record<string, unknown>; filter: QdrantFilter; wait: true }): Promise<unknown>;
};

/** The variable an older core read for each space's collection name. */
const COLLECTION_VARIABLES: Record<string, string> = {
  episodic_memory: "QDRANT_EPISODIC_COLLECTION",
  semantic_facts: "QDRANT_SEMANTIC_FACTS_COLLECTION",
  tool_corrections: "QDRANT_TOOL_CORRECTIONS_COLLECTION",
  verbatim_archive: "QDRANT_VERBATIM_COLLECTION",
};

/** Qdrant's filter for `where`, or none when it selects everything. */
function filterOf(where: VectorWhere | undefined): { filter?: QdrantFilter } {
  const must = Object.entries(where ?? {}).map(([key, value]) => ({ key, match: { value } }));
  return must.length === 0 ? {} : { filter: { must } };
}

/** The cursor for Qdrant's `next_page_offset`: a point id as it is, anything else as JSON; none on the last page. */
function cursorOf(offset: QdrantOffset): string | undefined {
  if (offset === null || offset === undefined) return undefined;
  return typeof offset === "string" ? offset : JSON.stringify(offset);
}

/** The offset a cursor stands for: a number or an object back from JSON, a point id as it is. */
function offsetOf(cursor: string): QdrantOffset {
  if (/^\d+$/.test(cursor) || cursor.startsWith("{")) {
    try {
      return JSON.parse(cursor) as QdrantOffset;
    } catch {
      return cursor;
    }
  }
  return cursor;
}

/** The index over `client`, each space in the collection `env` names for it, else in its own. */
export function createQdrantIndex(client: QdrantIndexClient, env: Record<string, string | undefined>): VectorIndex {
  const collection = (space: string): string => {
    const variable = COLLECTION_VARIABLES[space];
    return (variable === undefined ? undefined : env[variable]) || space;
  };
  return {
    ensure: async (space, spec) => {
      const name = collection(space);
      const { collections } = await client.getCollections();
      if (!collections.some((c) => c.name === name)) {
        await client.createCollection(name, { vectors: { size: spec.dimensions, distance: "Cosine" } });
      }
      for (const key of spec.keys ?? []) await client.createPayloadIndex(name, { field_name: key, field_schema: "keyword" });
      for (const key of spec.ordered ?? []) await client.createPayloadIndex(name, { field_name: key, field_schema: "datetime" });
    },
    upsert: async (space, points) => {
      await client.upsert(collection(space), { points });
    },
    query: async (space, q) => {
      const { points } = await client.query(collection(space), {
        query: q.vector,
        ...filterOf(q.where),
        limit: q.limit,
        with_payload: true,
      });
      return points.map((p) => ({ id: String(p.id), score: p.score, payload: p.payload ?? {} }));
    },
    scroll: async (space, q) => {
      const result = await client.scroll(collection(space), {
        ...filterOf(q.where),
        ...(q.orderBy === undefined ? {} : { order_by: q.orderBy }),
        limit: q.limit,
        ...(q.cursor === undefined ? {} : { offset: offsetOf(q.cursor) }),
        with_payload: true,
      });
      const next = cursorOf(result.next_page_offset);
      const points = result.points.map((p) => ({ id: String(p.id), payload: p.payload ?? {} }));
      return next === undefined ? { points } : { points, next };
    },
    setPayload: async (space, q) => {
      const { filter } = filterOf(q.where);
      if (filter === undefined) throw new Error("setPayload needs a where: it never rewrites a whole space");
      await client.setPayload(collection(space), { payload: q.payload, filter, wait: true });
    },
    health: async () => {
      try {
        await client.getCollections();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * The vector index on Qdrant, at `QDRANT_URL`. Building it doesn't reach
 * Qdrant: an index that isn't answering yet is the core's business.
 */
export function qdrantIndex(): VectorIndexPlugin {
  return {
    apiVersion: VECTOR_INDEX_API_VERSION,
    name: "qdrant",
    build: ({ env }) =>
      createQdrantIndex(new QdrantClient({ url: env.QDRANT_URL || "http://qdrant:6333" }), env),
  };
}
export { createQdrantConversations, qdrantConversations, titlePointId, type QdrantConversationsClient } from "./conversations.ts";
