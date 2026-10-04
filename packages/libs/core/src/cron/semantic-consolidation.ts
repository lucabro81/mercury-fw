/**
 * Deterministic promotion of clustered semantic facts to a standing wiki
 * note — the consolidation half of D-22/D-34, paired with
 * `semantic-fact-extractor.ts` (the LLM half, which only ever proposes
 * candidate facts). Zero model judgment here: given the last `k`
 * occurrences of a topic for a user, count the most common value and
 * compare it against whatever's already written in the person's
 * `users/<key>/inferred/<topic>.md` — write only if the challenger's
 * count strictly exceeds the incumbent's (never on a tie, and never when
 * no single value is unambiguously dominant in the current window). The
 * comparison runs inside the vault's commit chain (the writer's `when`), so
 * two consolidations of the same note can't both beat the same incumbent.
 */
import { parse as parseYaml } from "yaml";
import type { writeInferredNote, writeToolCorrectionNote } from "../wiki/wiki-note.ts";
import type { SemanticFactEntry } from "../memory/semantic-facts-store.ts";
import type { ToolCorrectionEntry } from "../memory/tool-corrections-store.ts";

type ClusterFn = (key: string, topic: string, limit: number) => Promise<SemanticFactEntry[]>;
type Confidence = "low" | "medium" | "high";

export type ConsolidationDeps = {
  vaultPath: string;
  clusterFn: ClusterFn;
  writeInferredNoteFn: typeof writeInferredNote;
  k?: number;
  confidenceForCount?: (dominantCount: number, k: number) => Confidence;
  now?: () => string;
};

type ToolCorrectionClusterFn = (tool: string, topic: string, limit: number) => Promise<ToolCorrectionEntry[]>;

/**
 * Same shape as `ConsolidationDeps`, keyed by `tool` instead of a person:
 * `writeNoteFn` deliberately doesn't take a person at all (unlike
 * `writeInferredNoteFn` above): a procedural
 * correction lives under `curated/standards/`, visible to every session
 * regardless of who asks, never scoped to one person's area.
 */
export type ToolCorrectionConsolidationDeps = {
  vaultPath: string;
  clusterFn: ToolCorrectionClusterFn;
  writeNoteFn: typeof writeToolCorrectionNote;
  k?: number;
  confidenceForCount?: (dominantCount: number, k: number) => Confidence;
  now?: () => string;
};

/** Window size for consolidation — how many recent occurrences of a topic to consider. Uncalibrated: chosen without real usage data, to revisit once there's actual traffic to tune against. */
export const DEFAULT_CONSOLIDATION_K = 3;

/**
 * Uncalibrated confidence bands, count relative to `k`: a single
 * occurrence is unconfirmed (low); repeated but not unanimous within the
 * tracked window is medium; the dominant value filling the whole window
 * is high. Same "revisit with real usage" caveat as `DEFAULT_CONSOLIDATION_K`.
 */
export function defaultConfidenceForCount(dominantCount: number, k: number): Confidence {
  if (dominantCount >= k) {
    return "high";
  }
  if (dominantCount > 1) {
    return "medium";
  }
  return "low";
}

// Generic over anything shaped like {value, timestamp} — both
// SemanticFactEntry and ToolCorrectionEntry satisfy this structurally,
// reused by consolidateSemanticFact and consolidateToolCorrection alike.
function dominantValue(
  entries: Array<{ value: string; timestamp: string }>,
): { value: string; supportingTimestamps: string[] } | null {
  const byValue = new Map<string, string[]>();
  for (const e of entries) {
    const timestamps = byValue.get(e.value) ?? [];
    timestamps.push(e.timestamp);
    byValue.set(e.value, timestamps);
  }

  let best: { value: string; timestamps: string[] } | null = null;
  let tie = false;
  for (const [value, timestamps] of byValue) {
    if (!best || timestamps.length > best.timestamps.length) {
      best = { value, timestamps };
      tie = false;
    } else if (timestamps.length === best.timestamps.length) {
      tie = true;
    }
  }

  if (!best || tie) {
    return null;
  }
  return { value: best.value, supportingTimestamps: best.timestamps };
}

/** How many occurrences the note `text` was derived from: 0 for no note, or one without `derived_from`. */
function incumbentCount(text: string | null): number {
  if (text === null) {
    return 0;
  }
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    return 0;
  }
  const frontmatter = parseYaml(match[1] as string) as { derived_from?: unknown };
  return Array.isArray(frontmatter.derived_from) ? frontmatter.derived_from.length : 0;
}

/**
 * Re-clusters `topic` for the person `key`, and promotes the dominant value to
 * a wiki note if it beats the current incumbent's count. No-op if the
 * cluster is empty or has no single dominant value. `key` is the user key,
 * the same one Qdrant's facts carry and the vault's area is named after.
 */
export async function consolidateSemanticFact(key: string, topic: string, deps: ConsolidationDeps): Promise<void> {
  const k = deps.k ?? DEFAULT_CONSOLIDATION_K;
  const confidenceForCount = deps.confidenceForCount ?? defaultConfidenceForCount;
  const cluster = (await deps.clusterFn(key, topic, k)).filter((e) => e.topic === topic);

  const dominant = dominantValue(cluster);
  if (!dominant) {
    return;
  }

  const now = deps.now ?? (() => new Date().toISOString());
  await deps.writeInferredNoteFn(
    deps.vaultPath,
    key,
    topic,
    {
      confidence: confidenceForCount(dominant.supportingTimestamps.length, k),
      derived_from: dominant.supportingTimestamps,
      last_reviewed: now(),
    },
    dominant.value,
    { when: (current) => dominant.supportingTimestamps.length > incumbentCount(current) },
  );
}

/**
 * Same promotion logic as `consolidateSemanticFact` — re-clusters `topic`
 * for `tool`, promotes the dominant value if it beats the incumbent's
 * count — but keyed by `tool` (a CLI, not a person) and writing to
 * `curated/standards/<tool>-<topic>.md` (global) instead of the person's
 * `users/<key>/inferred/<topic>.md`. No encoding needed here: a tool name
 * (e.g. "jira") never contains a path separator.
 */
export async function consolidateToolCorrection(
  tool: string,
  topic: string,
  deps: ToolCorrectionConsolidationDeps,
): Promise<void> {
  const k = deps.k ?? DEFAULT_CONSOLIDATION_K;
  const confidenceForCount = deps.confidenceForCount ?? defaultConfidenceForCount;
  const cluster = (await deps.clusterFn(tool, topic, k)).filter((e) => e.topic === topic);

  const dominant = dominantValue(cluster);
  if (!dominant) {
    return;
  }

  const now = deps.now ?? (() => new Date().toISOString());
  await deps.writeNoteFn(
    deps.vaultPath,
    tool,
    topic,
    {
      confidence: confidenceForCount(dominant.supportingTimestamps.length, k),
      derived_from: dominant.supportingTimestamps,
      last_reviewed: now(),
    },
    dominant.value,
    { when: (current) => dominant.supportingTimestamps.length > incumbentCount(current) },
  );
}
