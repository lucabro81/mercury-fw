/**
 * Read-only point enumeration, for `mfw memory` and the HTTP surface's
 * `/memory/scroll`: `episodic-store.ts`/`semantic-facts-store.ts` only wrap
 * similarity `search`, there's no other way to just list what's in a collection.
 * One page per call (not an auto-paging fetch-everything loop): a real
 * collection can be arbitrarily large, so the caller decides whether to
 * request another page via the returned `nextOffset`.
 */
// Matches @qdrant/js-client-rest's real ExtendedPointId-based offset type
// (`string | number | Record<string, unknown> | null`) — a scroll offset
// is an opaque cursor as far as this module is concerned, only ever
// forwarded verbatim, but it has to line up with the real client's type
// for a real `QdrantClient` instance to satisfy this structurally.
type ScrollOffset = string | number | Record<string, unknown> | null;

export type ScrollableQdrantClient = {
  scroll(
    collection: string,
    params: {
      limit: number;
      offset?: ScrollOffset;
      with_payload: boolean;
      filter?: { must: Array<{ key: string; match: { value: string } }> };
    },
  ): Promise<{
    points: Array<{ id: string | number; payload?: Record<string, unknown> | null }>;
    next_page_offset?: ScrollOffset;
  }>;
};

export type ScrollPage = {
  points: Array<{ id: string | number; payload: Record<string, unknown> | null }>;
  nextOffset: ScrollOffset;
};

/** One page of `collectionName`'s points; only the person `opts.userId`'s, when given (the per-person collections carry it as `userId`). */
export async function scrollCollection(
  client: ScrollableQdrantClient,
  collectionName: string,
  opts: { limit: number; offset?: ScrollOffset; userId?: string },
): Promise<ScrollPage> {
  const result = await client.scroll(collectionName, {
    limit: opts.limit,
    offset: opts.offset,
    with_payload: true,
    ...(opts.userId === undefined ? {} : { filter: { must: [{ key: "userId", match: { value: opts.userId } }] } }),
  });
  return {
    points: result.points.map((p) => ({ id: p.id, payload: p.payload ?? null })),
    nextOffset: result.next_page_offset ?? null,
  };
}
