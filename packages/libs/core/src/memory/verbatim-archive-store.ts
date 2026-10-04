/**
 * The verbatim conversation archive (issue #4): a durable, lossless
 * Qdrant collection holding the complete user↔model exchange, one point
 * per message, distinct from every other memory layer.
 *
 * How it differs from the neighbours in this directory:
 * - Layer-1 history (`../session/history.ts`) is a sliding window that
 *   summarizes itself away — lossy by design.
 * - The episodic store (`./episodic-store.ts`) captures a *summary* of a
 *   closed session — derived, not raw.
 * This archive instead keeps what was actually said, verbatim, so a later
 * session can resurface it and re-read it in light of new facts. It only
 * ever appends and reads; nothing here evicts (retention bounding is a
 * separate, later concern).
 *
 * Reuses `episodic-store.ts`'s structural `QdrantClientLike` — the same
 * subset of the real client every store in this directory shares.
 */
import type { QdrantClientLike } from "./episodic-store.ts";

/**
 * Creates `collectionName` (cosine distance, `vectorSize`-dim) if it
 * doesn't already exist, then ensures the `userId` keyword payload index
 * regardless — `searchVerbatim` filters by `userId` server-side, and the
 * index keeps that filter usable as the archive grows. Idempotent
 * (Qdrant no-ops re-creating an existing index), so safe to call on every
 * startup, including against a collection created before this existed.
 */
export async function ensureVerbatimCollection(
  client: QdrantClientLike,
  collectionName: string,
  vectorSize: number,
): Promise<void> {
  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === collectionName)) {
    await client.createCollection(collectionName, { vectors: { size: vectorSize, distance: "Cosine" } });
  }
  if (client.createPayloadIndex) {
    // `userId` for searchVerbatim's per-person filter; `sessionKey` for
    // listVerbatimBySession's per-conversation filter; `timestamp` (datetime)
    // for its chronological `order_by`. Qdrant rejects a filter/order_by on an
    // unindexed field with a 400, so all three must exist.
    await client.createPayloadIndex(collectionName, { field_name: "userId", field_schema: "keyword" });
    await client.createPayloadIndex(collectionName, { field_name: "sessionKey", field_schema: "keyword" });
    await client.createPayloadIndex(collectionName, { field_name: "timestamp", field_schema: "datetime" });
  }
}

/** A single verbatim message as it was emitted in chat. `timestamp` (ISO 8601, ms precision) is the durable ordering key. */
export type VerbatimMessage = {
  userId: string;
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

/** Embeds `entry.content` and upserts it as a new point in `collectionName`, payload carrying the full verbatim message. */
export async function appendVerbatimMessage(
  client: QdrantClientLike,
  collectionName: string,
  embed: (text: string) => Promise<number[]>,
  entry: VerbatimMessage,
): Promise<void> {
  const vector = await embed(entry.content);
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

/** Narrows an arbitrary payload to a `VerbatimMessage`, rejecting null/malformed points (e.g. from an older schema). */
function isVerbatimMessage(payload: Record<string, unknown> | null): payload is VerbatimMessage {
  return (
    payload !== null &&
    typeof payload.userId === "string" &&
    typeof payload.sessionKey === "string" &&
    (payload.role === "user" || payload.role === "assistant") &&
    typeof payload.content === "string" &&
    typeof payload.timestamp === "string"
  );
}

/**
 * The verbatim messages for a specific user most relevant to `queryText`
 * — e.g. "what did we say about KAN-1 last week". Filtered by `userId` so
 * one user's transcript never leaks into another's. Only reads; returns
 * the raw messages, ordering left to the caller (each carries its own
 * `timestamp`).
 */
export async function searchVerbatim(
  client: QdrantClientLike,
  collectionName: string,
  embed: (text: string) => Promise<number[]>,
  query: { userId: string; queryText: string; limit?: number },
): Promise<VerbatimMessage[]> {
  const vector = await embed(query.queryText);
  const results = await client.query(collectionName, {
    query: vector,
    filter: { must: [{ key: "userId", match: { value: query.userId } }] },
    limit: query.limit ?? DEFAULT_SEARCH_LIMIT,
    with_payload: true,
  });
  return results.points.map((r) => r.payload ?? null).filter(isVerbatimMessage);
}

/**
 * How many recent messages `listVerbatimSessions` scans to build the
 * conversation list. Qdrant has no native DISTINCT, so we dedup client-side
 * over a bounded window of the newest points — a conversation whose newest
 * message falls outside this window won't appear. Ample for a live-testing UI
 * sidebar; retention/aggregation is a separate later concern.
 */
const SESSION_SCAN_LIMIT = 500;

/** One conversation in the list view: its key, the timestamp of its most recent message, and a short preview of it. */
export type VerbatimSession = {
  sessionKey: string;
  lastTimestamp: string;
  preview: string;
};

/** Max characters of the most-recent message shown as a conversation's preview. */
const PREVIEW_CHARS = 120;

/**
 * One person's conversations, most-recently-active first — the sidebar a UI
 * shows to switch between them. Scrolls the person's newest `SESSION_SCAN_LIMIT`
 * messages (timestamp desc) and dedups by `sessionKey`, keeping each
 * conversation's most recent message for its timestamp and preview, then caps
 * the result at `limit`. Returns empty if the client can't scroll.
 */
export async function listVerbatimSessions(
  client: QdrantClientLike,
  collectionName: string,
  query: { userId: string; limit: number },
): Promise<{ conversations: VerbatimSession[] }> {
  if (!client.scroll) {
    return { conversations: [] };
  }
  const result = await client.scroll(collectionName, {
    filter: { must: [{ key: "userId", match: { value: query.userId } }] },
    order_by: { key: "timestamp", direction: "desc" },
    limit: SESSION_SCAN_LIMIT,
    with_payload: true,
  });
  const messages = result.points.map((p) => p.payload ?? null).filter(isVerbatimMessage);
  const seen = new Map<string, VerbatimSession>();
  for (const m of messages) {
    if (seen.has(m.sessionKey)) {
      continue; // desc order → first occurrence is the most recent
    }
    seen.set(m.sessionKey, {
      sessionKey: m.sessionKey,
      lastTimestamp: m.timestamp,
      preview: m.content.length <= PREVIEW_CHARS ? m.content : `${m.content.slice(0, PREVIEW_CHARS)}…`,
    });
  }
  return { conversations: [...seen.values()].slice(0, query.limit) };
}

/** A page of a conversation's verbatim messages, plus the opaque cursor for the next page (null when exhausted). */
export type VerbatimPage = {
  messages: VerbatimMessage[];
  nextOffset: string | number | Record<string, unknown> | null;
};

/**
 * The verbatim messages of one conversation (`sessionKey`) in chronological
 * order — the durable transcript a UI renders when it (re)loads a conversation.
 * Unlike `searchVerbatim` this is a plain scroll (no similarity), filtered by
 * the person (`userId`) and the conversation (`sessionKey`), so a session key
 * that isn't the person's own yields nothing, ordered by `timestamp`
 * ascending, paged via the opaque `offset` cursor. Returns empty if the client
 * can't scroll.
 */
export async function listVerbatimBySession(
  client: QdrantClientLike,
  collectionName: string,
  query: { userId: string; sessionKey: string; limit: number; offset?: string | number | Record<string, unknown> | null },
): Promise<VerbatimPage> {
  if (!client.scroll) {
    return { messages: [], nextOffset: null };
  }
  const result = await client.scroll(collectionName, {
    filter: {
      must: [
        { key: "userId", match: { value: query.userId } },
        { key: "sessionKey", match: { value: query.sessionKey } },
      ],
    },
    order_by: { key: "timestamp", direction: "asc" },
    limit: query.limit,
    offset: query.offset,
    with_payload: true,
  });
  return {
    messages: result.points.map((p) => p.payload ?? null).filter(isVerbatimMessage),
    nextOffset: result.next_page_offset ?? null,
  };
}
