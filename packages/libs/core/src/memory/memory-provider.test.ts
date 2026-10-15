import { describe, it, expect } from "bun:test";
import { createVerbatimArchiveProvider } from "./memory-provider.ts";
import type { QdrantClientLike } from "./episodic-store.ts";

describe("createVerbatimArchiveProvider — captureExchange", () => {
  it("stamps the timestamp from the injected clock and appends the verbatim message to the store", async () => {
    let upserted: Record<string, unknown> | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async (_collection, params) => {
        upserted = (params.points[0] as { payload: Record<string, unknown> }).payload;
        return {};
      },
      query: async () => ({ points: [] }),
    };
    const provider = createVerbatimArchiveProvider({
      client,
      collectionName: "verbatim_archive",
      embed: async () => [1, 2, 3],
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });

    await provider.captureExchange!({
      userId: "users/42",
      sessionKey: "spaces/X:users/42",
      role: "user",
      content: "come sta KAN-1?",
    });

    expect(upserted).toEqual({
      userId: "users/42",
      sessionKey: "spaces/X:users/42",
      role: "user",
      content: "come sta KAN-1?",
      timestamp: "2026-09-22T12:00:00.000Z",
    });
  });

  // Regression: a turn whose model output is only a present()/tool call (no
  // prose) leaves the assistant text empty. Capturing it would store a
  // meaningless empty point AND risk embed("") throwing — which, being the
  // second capture await, would strand the already-captured user message with
  // no assistant counterpart. Empty content must be skipped, not stored.
  it("skips capture entirely when the content is empty or whitespace-only", async () => {
    let upsertCalls = 0;
    let embedCalls = 0;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => {
        upsertCalls++;
        return {};
      },
      query: async () => ({ points: [] }),
    };
    const provider = createVerbatimArchiveProvider({
      client,
      collectionName: "verbatim_archive",
      embed: async () => {
        embedCalls++;
        return [1, 2, 3];
      },
    });

    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "" });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "   \n  " });

    expect(upsertCalls).toBe(0);
    expect(embedCalls).toBe(0);
  });

  // #215: the archive keeps what the turn showed after the answer.
  it("archives the displays with the answer, and an answer that is only displays", async () => {
    const upserted: Array<Record<string, unknown>> = [];
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async (_collection, params) => {
        upserted.push((params.points[0] as { payload: Record<string, unknown> }).payload);
        return {};
      },
      query: async () => ({ points: [] }),
    };
    const provider = createVerbatimArchiveProvider({
      client,
      collectionName: "verbatim_archive",
      embed: async () => [1, 2, 3],
      now: () => new Date("2026-10-15T10:00:00.000Z"),
    });

    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "Ecco:", displays: ["KAN-1"] });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: "", displays: ["KAN-2"] });
    await provider.captureExchange!({ userId: "u", sessionKey: "s", role: "assistant", content: " ", displays: [""] });

    expect(upserted).toEqual([
      { userId: "u", sessionKey: "s", role: "assistant", content: "Ecco:", displays: ["KAN-1"], timestamp: "2026-10-15T10:00:00.000Z" },
      { userId: "u", sessionKey: "s", role: "assistant", content: "", displays: ["KAN-2"], timestamp: "2026-10-15T10:00:00.000Z" },
    ]);
  });
});

describe("createVerbatimArchiveProvider — recall_verbatim tool", () => {
  it("searches the archive scoped to the context's userId and returns the matched messages", async () => {
    let queryArgs: { collection: string; params: Record<string, unknown> } | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async (collection, params) => {
        queryArgs = { collection, params: params as Record<string, unknown> };
        return {
          points: [
            {
              id: "p1",
              score: 0.9,
              payload: {
                userId: "users/42",
                sessionKey: "spaces/X:users/42",
                role: "assistant",
                content: "la settimana scorsa KAN-1 era In Review",
                timestamp: "2026-09-15T09:00:00.000Z",
              },
            },
          ],
        };
      },
    };
    const provider = createVerbatimArchiveProvider({
      client,
      collectionName: "verbatim_archive",
      embed: async (text: string) => [text.length, 0, 0],
    });

    const tools = provider.sessionTools!({ sessionKey: "spaces/X:users/42", userId: "users/42" });
    const result = (await tools.recall_verbatim!.execute!({ query: "cosa dicevamo di KAN-1" }, {} as never)) as {
      ok: true;
      messages: unknown[];
    };

    expect(queryArgs?.collection).toBe("verbatim_archive");
    expect(queryArgs?.params.filter).toEqual({ must: [{ key: "userId", match: { value: "users/42" } }] });
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([
      {
        userId: "users/42",
        sessionKey: "spaces/X:users/42",
        role: "assistant",
        content: "la settimana scorsa KAN-1 era In Review",
        timestamp: "2026-09-15T09:00:00.000Z",
      },
    ]);
  });

  it("forwards a custom limit to the store search", async () => {
    let receivedLimit: number | undefined;
    const client: QdrantClientLike = {
      getCollections: async () => ({ collections: [] }),
      createCollection: async () => ({}),
      upsert: async () => ({}),
      query: async (_collection, params) => {
        receivedLimit = (params as { limit: number }).limit;
        return { points: [] };
      },
    };
    const provider = createVerbatimArchiveProvider({
      client,
      collectionName: "verbatim_archive",
      embed: async () => [0, 0, 0],
    });

    const tools = provider.sessionTools!({ sessionKey: "s", userId: "users/42" });
    await tools.recall_verbatim!.execute!({ query: "x", limit: 3 }, {} as never);

    expect(receivedLimit).toBe(3);
  });
});
