/**
 * Layer 3 (Qdrant) episodic storage: one point per closed,
 * summarized session — a raw, dated "what happened", not an
 * interpretation. Consolidation into semantic memory (per-topic
 * promotion into the wiki) is a separate, later concern that
 * reads from this collection; this module only ever writes to it.
 *
 * `QdrantClientLike` describes only the subset of `@qdrant/js-client-rest`'s
 * `QdrantClient` this file actually calls — real client instances satisfy
 * it structurally, tests use a plain object instead of a real connection.
 */
export type QdrantClientLike = {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(
    name: string,
    params: { vectors: { size: number; distance: "Cosine" | "Euclid" | "Dot" | "Manhattan" } },
  ): Promise<unknown>;
  upsert(
    name: string,
    params: { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> },
  ): Promise<unknown>;
  /** @qdrant/js-client-rest 1.19 removed `search` in favour of the universal
   * `query` endpoint: the vector moves to `query`, and results come back under
   * `.points` instead of as a bare array. */
  query(
    name: string,
    params: { query: number[]; filter: Record<string, unknown>; limit: number; with_payload: boolean },
  ): Promise<{ points: Array<{ id: string | number; score: number; payload?: Record<string, unknown> | null }> }>;
  /**
   * Optional — not part of the similarity-search surface every caller
   * needs, only used by `getLastSessionEpisodicSummaries` below. Optional
   * so `semantic-facts-store.ts`/`tool-corrections-store.ts` (which share
   * this type but never call `scroll`) don't need a stub in every test
   * fixture.
   */
  scroll?(
    name: string,
    params: {
      filter: Record<string, unknown>;
      order_by: { key: string; direction: "asc" | "desc" };
      limit: number;
      /** Opaque pagination cursor (from a prior page's `next_page_offset`). */
      offset?: string | number | Record<string, unknown> | null;
      /** Whether to return point payloads (`listVerbatimBySession` needs them). */
      with_payload?: boolean;
    },
  ): Promise<{
    points: Array<{ id: string | number; payload?: Record<string, unknown> | null }>;
    next_page_offset?: string | number | Record<string, unknown> | null;
  }>;
  /** Optional — same reasoning as `scroll` above: only `ensureEpisodicCollection` needs it. */
  createPayloadIndex?(name: string, params: { field_name: string; field_schema: "datetime" | "keyword" }): Promise<unknown>;
};

/**
 * Creates `collectionName` (cosine distance, `vectorSize`-dim) if it
 * doesn't already exist, then ensures the `timestamp`/`userId`/`sessionKey`
 * payload indexes exist regardless — `getLastSessionEpisodicSummaries`'s
 * `order_by`/filter scroll queries fail with an HTTP 400 without them.
 * Idempotent either way (Qdrant no-ops re-creating an existing index), so
 * safe to call on every startup, including against a collection that
 * predates this fix.
 */
export async function ensureEpisodicCollection(
  client: QdrantClientLike,
  collectionName: string,
  vectorSize: number,
): Promise<void> {
  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === collectionName)) {
    await client.createCollection(collectionName, { vectors: { size: vectorSize, distance: "Cosine" } });
  }
  if (client.createPayloadIndex) {
    await client.createPayloadIndex(collectionName, { field_name: "timestamp", field_schema: "datetime" });
    await client.createPayloadIndex(collectionName, { field_name: "userId", field_schema: "keyword" });
    // For getEpisodicSummariesBySession's per-conversation filter.
    await client.createPayloadIndex(collectionName, { field_name: "sessionKey", field_schema: "keyword" });
  }
}

export type EpisodicSummary = {
  userId: string;
  sessionKey: string;
  summary: string;
  timestamp: string;
};

/** Embeds `entry.summary` and upserts it as a new point in `collectionName`, payload carrying the full entry. */
export async function storeEpisodicSummary(
  client: QdrantClientLike,
  collectionName: string,
  embed: (text: string) => Promise<number[]>,
  entry: EpisodicSummary,
): Promise<void> {
  const vector = await embed(entry.summary);
  await client.upsert(collectionName, {
    points: [
      {
        id: crypto.randomUUID(),
        vector,
        payload: { ...entry },
      },
    ],
  });
}

const DEFAULT_SEARCH_LIMIT = 5;

function isEpisodicSummary(payload: Record<string, unknown> | null): payload is EpisodicSummary {
  return (
    payload !== null &&
    typeof payload.userId === "string" &&
    typeof payload.sessionKey === "string" &&
    typeof payload.summary === "string" &&
    typeof payload.timestamp === "string"
  );
}

/**
 * Past episodic events for a specific user, most relevant to `queryText`
 * (e.g. "notifications about KAN-123") — lets Mercury see how many times
 * it already notified this user about a given item before composing a
 * message. Not a general-purpose semantic consolidation/pattern-extraction
 * engine (that doesn't exist here) — this only ever reads, never writes
 * or promotes anything.
 */
export async function searchEpisodicMemory(
  client: QdrantClientLike,
  collectionName: string,
  embed: (text: string) => Promise<number[]>,
  query: { userId: string; queryText: string; limit?: number },
): Promise<EpisodicSummary[]> {
  const vector = await embed(query.queryText);
  const results = await client.query(collectionName, {
    query: vector,
    filter: { must: [{ key: "userId", match: { value: query.userId } }] },
    limit: query.limit ?? DEFAULT_SEARCH_LIMIT,
    with_payload: true,
  });
  return results.points.map((r) => r.payload ?? null).filter(isEpisodicSummary);
}

const DEFAULT_SESSION_LIMIT = 3;

/**
 * The last closed session's episodic entries for `userId`, most recent
 * first — up to `limit` entries, all sharing the same `sessionKey` as the
 * single most recent entry. Used to seed a brand-new session's context
 * primer with "what happened last time"; not similarity-scoped like
 * `searchEpisodicMemory` (there's no query yet to compare against at
 * session start). Returns an empty array (never throws) if the client
 * doesn't support `scroll`, or if the user has no prior episodic entries —
 * this is enrichment, the caller must work fine without it.
 */
export async function getLastSessionEpisodicSummaries(
  client: QdrantClientLike,
  collectionName: string,
  query: { userId: string; limit?: number },
): Promise<EpisodicSummary[]> {
  if (!client.scroll) {
    return [];
  }

  const latest = await client.scroll(collectionName, {
    filter: { must: [{ key: "userId", match: { value: query.userId } }] },
    order_by: { key: "timestamp", direction: "desc" },
    limit: 1,
  });
  const mostRecent = latest.points[0]?.payload ?? null;
  if (!isEpisodicSummary(mostRecent)) {
    return [];
  }

  const session = await client.scroll(collectionName, {
    filter: {
      must: [
        { key: "userId", match: { value: query.userId } },
        { key: "sessionKey", match: { value: mostRecent.sessionKey } },
      ],
    },
    order_by: { key: "timestamp", direction: "desc" },
    limit: query.limit ?? DEFAULT_SESSION_LIMIT,
  });
  return session.points.map((p) => p.payload ?? null).filter(isEpisodicSummary);
}

/** How many summaries of one conversation `getEpisodicSummariesBySession` reads at most. */
const SESSION_SUMMARIES_LIMIT = 100;

/**
 * The episodic summaries of one conversation (`sessionKey`) of the person
 * `userId`, oldest first — what a resumed conversation knows of its part
 * that no longer fits verbatim. Empty when the client can't scroll.
 */
export async function getEpisodicSummariesBySession(
  client: QdrantClientLike,
  collectionName: string,
  query: { userId: string; sessionKey: string },
): Promise<EpisodicSummary[]> {
  if (!client.scroll) {
    return [];
  }
  const result = await client.scroll(collectionName, {
    filter: {
      must: [
        { key: "userId", match: { value: query.userId } },
        { key: "sessionKey", match: { value: query.sessionKey } },
      ],
    },
    order_by: { key: "timestamp", direction: "asc" },
    limit: SESSION_SUMMARIES_LIMIT,
    with_payload: true,
  });
  return result.points.map((p) => p.payload ?? null).filter(isEpisodicSummary);
}
