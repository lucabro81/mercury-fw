import { describe, it, expect } from "bun:test";
import { scrollCollection, type ScrollableQdrantClient } from "./qdrant-scroll.ts";

describe("scrollCollection", () => {
  it("requests one page with the given limit and no offset when none was passed", async () => {
    let receivedArgs: unknown;
    const client: ScrollableQdrantClient = {
      scroll: async (_collection, params) => {
        receivedArgs = params;
        return { points: [{ id: "p1", payload: { a: 1 } }], next_page_offset: null };
      },
    };

    await scrollCollection(client, "episodic_memory", { limit: 10 });

    expect(receivedArgs).toEqual({ limit: 10, offset: undefined, with_payload: true });
  });

  it("restricts the page to one person's points when given a userId", async () => {
    let receivedArgs: unknown;
    const client: ScrollableQdrantClient = {
      scroll: async (_collection, params) => {
        receivedArgs = params;
        return { points: [], next_page_offset: null };
      },
    };

    await scrollCollection(client, "episodic_memory", { limit: 10, userId: "static:alice" });

    expect(receivedArgs).toEqual({
      limit: 10,
      offset: undefined,
      with_payload: true,
      filter: { must: [{ key: "userId", match: { value: "static:alice" } }] },
    });
  });

  it("forwards a given offset to the client verbatim", async () => {
    let receivedOffset: unknown;
    const client: ScrollableQdrantClient = {
      scroll: async (_collection, params) => {
        receivedOffset = params.offset;
        return { points: [], next_page_offset: null };
      },
    };

    await scrollCollection(client, "episodic_memory", { limit: 10, offset: "abc-123" });

    expect(receivedOffset).toBe("abc-123");
  });

  it("maps points and reports the next offset when the collection has more pages", async () => {
    const client: ScrollableQdrantClient = {
      scroll: async () => ({
        points: [
          { id: "p1", payload: { userId: "u1" } },
          { id: "p2", payload: null },
        ],
        next_page_offset: "next-page-token",
      }),
    };

    const result = await scrollCollection(client, "episodic_memory", { limit: 10 });

    expect(result).toEqual({
      points: [
        { id: "p1", payload: { userId: "u1" } },
        { id: "p2", payload: null },
      ],
      nextOffset: "next-page-token",
    });
  });

  it("reports a null next offset (not undefined) on the last page, so callers have one clear stop signal", async () => {
    const client: ScrollableQdrantClient = {
      scroll: async () => ({ points: [{ id: "p1", payload: {} }], next_page_offset: undefined }),
    };

    const result = await scrollCollection(client, "episodic_memory", { limit: 10 });

    expect(result.nextOffset).toBeNull();
  });

  it("defaults payload to null when a point has none, instead of leaving it undefined", async () => {
    const client: ScrollableQdrantClient = {
      scroll: async () => ({ points: [{ id: "p1" }], next_page_offset: null }),
    };

    const result = await scrollCollection(client, "episodic_memory", { limit: 10 });

    expect(result.points).toEqual([{ id: "p1", payload: null }]);
  });
});
