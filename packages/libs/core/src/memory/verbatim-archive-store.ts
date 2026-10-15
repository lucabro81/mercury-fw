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

/**
 * A single verbatim message as it was emitted in chat. `timestamp` (ISO 8601,
 * ms precision) is the durable ordering key. `content` is what the model said;
 * `displays` are what the turn showed after it (the lists the model chose to
 * `present`), absent on messages archived before they were kept.
 */
export type VerbatimMessage = {
  userId: string;
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  displays?: string[];
  timestamp: string;
};

/**
 * What the person saw: the model's text followed by the displays, non-empty
 * parts only, a blank line between them. The turn's final text is built the
 * same way.
 */
export function shownText(content: string, displays: string[] | undefined): string {
  return [content, ...(displays ?? [])].filter((part) => part !== "").join("\n\n");
}

/** `m` as the person saw it, for whatever renders a conversation: the displays folded into `content`. */
function asShown(m: VerbatimMessage): VerbatimMessage {
  const { displays, ...rest } = m;
  return displays === undefined ? rest : { ...rest, content: shownText(m.content, displays) };
}

/** `m` as the model said it, for whatever hands it back to the model: no displays. */
function asSaid(m: VerbatimMessage): VerbatimMessage {
  const { displays: _displays, ...rest } = m;
  return rest;
}

/**
 * Embeds `entry.content` (what was shown, when the model said nothing) and
 * upserts it as a new point in `collectionName`, payload carrying the full
 * verbatim message.
 */
export async function appendVerbatimMessage(
  client: QdrantClientLike,
  collectionName: string,
  embed: (text: string) => Promise<number[]>,
  entry: VerbatimMessage,
): Promise<void> {
  const vector = await embed(entry.content !== "" ? entry.content : shownText(entry.content, entry.displays));
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
    (payload.displays === undefined ||
      (Array.isArray(payload.displays) && payload.displays.every((d) => typeof d === "string"))) &&
    typeof payload.timestamp === "string"
  );
}

/**
 * The verbatim messages for a specific user most relevant to `queryText`
 * — e.g. "what did we say about KAN-1 last week". Filtered by `userId` so
 * one user's transcript never leaks into another's. Only reads; returns
 * the messages as the model said them (no displays: this goes back to the
 * model), ordering left to the caller (each carries its own `timestamp`).
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
  return results.points.map((r) => r.payload ?? null).filter(isVerbatimMessage).map(asSaid);
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
 * conversation's most recent message for its timestamp and preview (of what
 * was shown, displays included), then caps
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
    const shown = shownText(m.content, m.displays);
    seen.set(m.sessionKey, {
      sessionKey: m.sessionKey,
      lastTimestamp: m.timestamp,
      preview: shown.length <= PREVIEW_CHARS ? shown : `${shown.slice(0, PREVIEW_CHARS)}…`,
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
 * ascending, paged via the opaque `offset` cursor. Each message comes as the
 * person saw it, its displays folded into `content`. Returns empty if the client
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
    messages: result.points.map((p) => p.payload ?? null).filter(isVerbatimMessage).map(asShown),
    nextOffset: result.next_page_offset ?? null,
  };
}

/** How many of a conversation's newest messages `listVerbatimTail` reads at most. */
const TAIL_SCAN_LIMIT = 200;

/**
 * The end of a conversation, oldest first, and whether it reaches the
 * conversation's first message. `leftOutAt` is the timestamp of the newest
 * archived message left out of it (absent when complete): what came before
 * the tail, which a summary has to cover.
 */
export type VerbatimTail = {
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>;
  complete: boolean;
  leftOutAt?: string;
};

/**
 * The newest messages of one conversation (`sessionKey`) of the person
 * `userId` whose content fits `maxChars`, in chronological order — what a
 * resumed conversation hands back to the model. Reads at most
 * `TAIL_SCAN_LIMIT` messages, newest first, stops at the first one that
 * doesn't fit, and drops leading assistant messages, so the tail always
 * opens with what the person said. `complete` is true only when every
 * message of the conversation made it in. Empty and incomplete when the
 * client can't scroll.
 */
export async function listVerbatimTail(
  client: QdrantClientLike,
  collectionName: string,
  query: { userId: string; sessionKey: string; maxChars: number },
): Promise<VerbatimTail> {
  if (!client.scroll) {
    return { messages: [], complete: false };
  }
  const result = await client.scroll(collectionName, {
    filter: {
      must: [
        { key: "userId", match: { value: query.userId } },
        { key: "sessionKey", match: { value: query.sessionKey } },
      ],
    },
    order_by: { key: "timestamp", direction: "desc" },
    limit: TAIL_SCAN_LIMIT,
    with_payload: true,
  });
  const newestFirst = result.points.map((p) => p.payload ?? null).filter(isVerbatimMessage);
  const taken: VerbatimMessage[] = [];
  let chars = 0;
  for (const m of newestFirst) {
    if (chars + m.content.length > query.maxChars) break;
    chars += m.content.length;
    taken.push(m);
  }
  const chronological = taken.reverse();
  const firstUser = chronological.findIndex((m) => m.role === "user");
  const kept = firstUser === -1 ? [] : chronological.slice(firstUser);
  const messages = kept.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp }));
  const complete = result.points.length < TAIL_SCAN_LIMIT && messages.length === newestFirst.length;
  if (complete) return { messages, complete };
  // Newest first, the first message not kept.
  const leftOut = newestFirst[kept.length];
  return leftOut === undefined ? { messages, complete } : { messages, complete, leftOutAt: leftOut.timestamp };
}
