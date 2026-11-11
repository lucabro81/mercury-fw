/**
 * Layer 3's startup setup (the vector index's spaces, the archive's
 * collections, the embedding model's vector length), run in the background so
 * an index or a model that isn't answering never stops Mercury from starting:
 * memory is enrichment and fails soft (principle 3).
 */
import type { TraceInput } from "../traces/tracer.ts";

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
