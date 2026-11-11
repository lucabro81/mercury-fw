/**
 * Layer 3 semantic facts storage — one space of the vector index, separate from
 * `episodic-store.ts`. Episodic points are a raw dated account of a whole
 * session; semantic facts are `{topic, value}` pairs extracted from a
 * session, clustered per user+topic, and deterministically promoted to a
 * standing wiki note. This module only owns the space;
 * extraction, clustering, and promotion are separate concerns built on
 * top of it.
 */
import type { VectorIndex } from "@mercury-fw/channel-types";

/** The vector index's space the facts live in. */
export const SEMANTIC_FACTS_SPACE = "semantic_facts";

/** Makes sure the space exists with `dimensions`-long vectors; idempotent, safe on every startup. */
export async function ensureSemanticFactsSpace(index: VectorIndex, dimensions: number): Promise<void> {
  await index.ensure(SEMANTIC_FACTS_SPACE, { dimensions });
}

export type SemanticFactEntry = {
  userId: string;
  topic: string;
  value: string;
  timestamp: string;
};

/**
 * Embeds `entry.topic` alone (never `topic + value`) and upserts it as a
 * new point, payload carrying the full entry. One
 * point per extracted fact, never an update-in-place — consolidation
 * reads the whole history back via `searchSemanticFactsByTopic` and
 * decides what to promote.
 */
export async function storeSemanticFact(
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  entry: SemanticFactEntry,
): Promise<void> {
  const vector = await embed(entry.topic);
  await index.upsert(SEMANTIC_FACTS_SPACE, [{ id: crypto.randomUUID(), vector, payload: { ...entry } }]);
}

const DEFAULT_SEARCH_LIMIT = 5;

function isSemanticFactEntry(payload: Record<string, unknown> | null): payload is SemanticFactEntry {
  return (
    payload !== null &&
    typeof payload.userId === "string" &&
    typeof payload.topic === "string" &&
    typeof payload.value === "string" &&
    typeof payload.timestamp === "string"
  );
}

/**
 * Past facts for a specific user, clustered by topic similarity — the
 * read side consolidation uses to gather "every occurrence of roughly
 * this topic" before counting a dominant value. Filters by userId so
 * one user's facts never leak into another's cluster.
 */
export async function searchSemanticFactsByTopic(
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  query: { userId: string; topic: string; limit?: number },
): Promise<SemanticFactEntry[]> {
  const vector = await embed(query.topic);
  const results = await index.query(SEMANTIC_FACTS_SPACE, { vector, where: { userId: query.userId }, limit: query.limit ?? DEFAULT_SEARCH_LIMIT });
  return results.map((r) => r.payload).filter(isSemanticFactEntry);
}
