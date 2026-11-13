/**
 * Layer 3 episodic storage: one point per closed, summarized session in the
 * vector index's `episodic_memory` space — a raw, dated "what happened", not
 * an interpretation. Consolidation into semantic memory (per-topic promotion
 * into the wiki) is a separate, later concern; this module only writes the
 * summaries and reads them back.
 */
import type { VectorIndex } from "@mercury-fw/channel-types";

/** The vector index's space the episodic summaries live in. */
export const EPISODIC_SPACE = "episodic_memory";

/**
 * Makes sure the episodic space exists with `dimensions`-long vectors and the
 * fields its reads filter (`userId`, `sessionKey`) and order (`timestamp`)
 * on — `getLastSessionEpisodicSummaries`' ordered, filtered scroll fails
 * without them. Idempotent, safe on every startup.
 */
export async function ensureEpisodicSpace(index: VectorIndex, dimensions: number): Promise<void> {
  await index.ensure(EPISODIC_SPACE, { dimensions, keys: ["userId", "sessionKey"], ordered: ["timestamp"] });
}

export type EpisodicSummary = {
  userId: string;
  sessionKey: string;
  summary: string;
  timestamp: string;
};

/** Embeds `entry.summary` and stores it as a new point, payload carrying the full entry. */
export async function storeEpisodicSummary(
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  entry: EpisodicSummary,
): Promise<void> {
  const vector = await embed(entry.summary);
  await index.upsert(EPISODIC_SPACE, [{ id: crypto.randomUUID(), vector, payload: { ...entry } }]);
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
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  query: { userId: string; queryText: string; limit?: number },
): Promise<EpisodicSummary[]> {
  const vector = await embed(query.queryText);
  const results = await index.query(EPISODIC_SPACE, {
    vector,
    where: { userId: query.userId },
    limit: query.limit ?? DEFAULT_SEARCH_LIMIT,
  });
  return results.map((r) => r.payload).filter(isEpisodicSummary);
}

const DEFAULT_SESSION_LIMIT = 3;

/**
 * The last closed session's episodic entries for `userId`, most recent
 * first — up to `limit` entries, all sharing the same `sessionKey` as the
 * single most recent entry. Used to seed a brand-new session's context
 * primer with "what happened last time"; not similarity-scoped like
 * `searchEpisodicMemory` (there's no query yet to compare against at
 * session start). Empty when the user has no prior episodic entries.
 */
export async function getLastSessionEpisodicSummaries(
  index: VectorIndex,
  query: { userId: string; limit?: number },
): Promise<EpisodicSummary[]> {
  const latest = await index.scroll(EPISODIC_SPACE, {
    where: { userId: query.userId },
    orderBy: { key: "timestamp", direction: "desc" },
    limit: 1,
  });
  const mostRecent = latest.points[0]?.payload ?? null;
  if (!isEpisodicSummary(mostRecent)) {
    return [];
  }

  const session = await index.scroll(EPISODIC_SPACE, {
    where: { userId: query.userId, sessionKey: mostRecent.sessionKey },
    orderBy: { key: "timestamp", direction: "desc" },
    limit: query.limit ?? DEFAULT_SESSION_LIMIT,
  });
  return session.points.map((p) => p.payload).filter(isEpisodicSummary);
}

/** How many summaries of one conversation `getEpisodicSummariesBySession` reads at most. */
const SESSION_SUMMARIES_LIMIT = 100;

/**
 * The episodic summaries of one conversation (`sessionKey`) of the person
 * `userId`, oldest first — what a resumed conversation knows of its part
 * that no longer fits verbatim.
 */
export async function getEpisodicSummariesBySession(
  index: VectorIndex,
  query: { userId: string; sessionKey: string },
): Promise<EpisodicSummary[]> {
  const result = await index.scroll(EPISODIC_SPACE, {
    where: { userId: query.userId, sessionKey: query.sessionKey },
    orderBy: { key: "timestamp", direction: "asc" },
    limit: SESSION_SUMMARIES_LIMIT,
  });
  return result.points.map((p) => p.payload).filter(isEpisodicSummary);
}
