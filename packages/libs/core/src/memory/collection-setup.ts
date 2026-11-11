/**
 * Layer 3's startup setup (creating the Qdrant collections and their indexes),
 * run in the background so an unreachable Qdrant never stops Mercury from
 * starting: the episodic store is enrichment and fails soft (principle 3).
 */
import type { TraceInput } from "../traces/tracer.ts";

/**
 * Runs `setup` now and, while it fails, again every `retryMs`, on a timer that
 * doesn't keep the process alive. Logs once when Qdrant goes missing and once
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
          log("Qdrant reachable, memory collections ready");
          emit?.({ kind: "system.recovered", area: "memory-store" });
        }
        resolve();
      } catch (err) {
        if (!failing) {
          log(`Qdrant unreachable, Layer-3 memory is off until it answers (retrying every ${retryMs / 1000}s): ${String(err)}`);
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
