/**
 * Layer 3's startup setup (the vector index's spaces, the archive's
 * collections, the embedding model's vector length), run in the background so
 * an index or a model that isn't answering never stops Mercury from starting:
 * memory is enrichment and fails soft (principle 3).
 */
import type { VectorIndex } from "@mercury-fw/channel-types";
import type { TraceInput } from "../traces/tracer.ts";
import { EPISODIC_SPACE, ensureEpisodicSpace } from "./episodic-store.ts";
import { SEMANTIC_FACTS_SPACE, ensureSemanticFactsSpace } from "./semantic-facts-store.ts";
import { ensureToolCorrectionsSpace } from "./tool-corrections-store.ts";
import { VERBATIM_SPACE, ensureVerbatimCollection } from "./verbatim-archive-store.ts";
import { ensureTitlesCollection } from "./conversation-titles-store.ts";
import type { QdrantClientLike } from "./qdrant-client.ts";

/**
 * Runs `setup` now and, while it fails, again every `retryMs`, on a timer that
 * doesn't keep the process alive. Logs once when memory goes missing and once
 * when it's back, never per retry, and emits the same through `emit` (#23).
 * `done` resolves after the first success.
 */
export function setUpWhenReachable(
  setup: () => Promise<void>,
  { log, retryMs = 5000, emit }: { log: (msg: string) => void; retryMs?: number; emit?: (input: TraceInput) => void },
): { done: Promise<void> } {
  let failing = false;
  const done = new Promise<void>((resolve) => {
    const attempt = async () => {
      try {
        await setup();
        if (failing) {
          log("memory reachable, its spaces ready");
          emit?.({ kind: "system.recovered", area: "memory-store" });
        }
        resolve();
      } catch (err) {
        if (!failing) {
          log(
            `memory unreachable (the vector index or the embedding model), Layer-3 memory is off until it answers (retrying every ${retryMs / 1000}s): ${String(err)}`,
          );
          emit?.({ kind: "system.error", area: "memory-store", args: { error: String(err) } });
        }
        failing = true;
        setTimeout(attempt, retryMs).unref();
      }
    };
    void attempt();
  });
  return { done };
}

/** How long the embedding model's vectors are, found by embedding one probe text: the spaces' `dimensions`. */
export async function embeddingDimensions(embed: (text: string) => Promise<number[]>): Promise<number> {
  const vector = await embed("dimensions");
  if (vector.length === 0) throw new Error("the embedding model returned an empty vector");
  return vector.length;
}

/** The spaces whose points carry a person's `userId`, which the user-key migration rewrites. */
export const MIGRATED_SPACES = [EPISODIC_SPACE, SEMANTIC_FACTS_SPACE, VERBATIM_SPACE];

/**
 * One attempt at the memory's setup, for `setUpWhenReachable`: the titles'
 * collection first (it holds no vectors, so it needs no embedding model),
 * then the length of the embedding model's vectors, then the index's spaces
 * (when there's an index) and the archive's collection, that long. Throws on
 * the first step that fails; every step is idempotent.
 */
export async function setUpMemory(deps: {
  index?: VectorIndex;
  embed: (text: string) => Promise<number[]>;
  qdrant: QdrantClientLike;
  collections: { verbatim: string; titles: string };
}): Promise<void> {
  await ensureTitlesCollection(deps.qdrant, deps.collections.titles);
  const dimensions = await embeddingDimensions(deps.embed);
  if (deps.index !== undefined) {
    await ensureEpisodicSpace(deps.index, dimensions);
    await ensureSemanticFactsSpace(deps.index, dimensions);
    await ensureToolCorrectionsSpace(deps.index, dimensions);
  }
  await ensureVerbatimCollection(deps.qdrant, deps.collections.verbatim, dimensions);
}
