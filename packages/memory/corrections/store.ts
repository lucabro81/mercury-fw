/**
 * The procedural corrections in the vector index's `tool_corrections` space,
 * keyed by tool (a fact about a CLI, true for whoever uses it next), never by
 * person: each occurrence is a point, clustered by topic when the wiki
 * decides what becomes a note.
 */
import type { VectorIndex } from "@mercury-fw/plugin-types";

/** The vector index's space the corrections live in. */
export const TOOL_CORRECTIONS_SPACE = "tool_corrections";

/** Makes sure the space exists with `dimensions`-long vectors; idempotent, safe on every startup. */
export async function ensureToolCorrectionsSpace(index: VectorIndex, dimensions: number): Promise<void> {
  await index.ensure(TOOL_CORRECTIONS_SPACE, { dimensions });
}

export type ToolCorrectionEntry = {
  tool: string;
  topic: string;
  value: string;
  timestamp: string;
};

/** Embeds `entry.topic` alone (never `topic + value`), same reasoning as `storeSemanticFact` — upserts a new point, never an update-in-place. */
export async function storeToolCorrection(
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  entry: ToolCorrectionEntry,
): Promise<void> {
  const vector = await embed(entry.topic);
  await index.upsert(TOOL_CORRECTIONS_SPACE, [{ id: crypto.randomUUID(), vector, payload: { ...entry } }]);
}

const DEFAULT_SEARCH_LIMIT = 5;

function isToolCorrectionEntry(payload: Record<string, unknown> | null): payload is ToolCorrectionEntry {
  return (
    payload !== null &&
    typeof payload.tool === "string" &&
    typeof payload.topic === "string" &&
    typeof payload.value === "string" &&
    typeof payload.timestamp === "string"
  );
}

/** Past corrections for a specific tool, clustered by topic similarity — filters by `tool` so one tool's corrections never leak into another's cluster. */
export async function searchToolCorrectionsByTopic(
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  query: { tool: string; topic: string; limit?: number },
): Promise<ToolCorrectionEntry[]> {
  const vector = await embed(query.topic);
  const results = await index.query(TOOL_CORRECTIONS_SPACE, { vector, where: { tool: query.tool }, limit: query.limit ?? DEFAULT_SEARCH_LIMIT });
  return results.map((r) => r.payload).filter(isToolCorrectionEntry);
}
