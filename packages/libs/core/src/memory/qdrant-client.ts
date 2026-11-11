/**
 * The slice of `@qdrant/js-client-rest`'s `QdrantClient` the conversation
 * archive and the titles call directly: real client instances satisfy it
 * structurally, tests use a plain object instead of a real connection.
 * What's found by meaning goes through the vector index instead
 * (`@mercury-fw/channel-types`' `VectorIndex`).
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
  /** Optional, so a test double for a caller that never scrolls needn't stub it. */
  scroll?(
    name: string,
    params: {
      filter: Record<string, unknown>;
      /** Absent for a scroll that only filters (`conversation-titles-store.ts`). */
      order_by?: { key: string; direction: "asc" | "desc" };
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
  /** Optional, same reasoning as `scroll`. */
  createPayloadIndex?(name: string, params: { field_name: string; field_schema: "datetime" | "keyword" }): Promise<unknown>;
};
