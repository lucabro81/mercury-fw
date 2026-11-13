/**
 * The conversation store's startup setup (`ConversationStore.ready`), run in
 * the background so a store that isn't answering never stops Mercury from
 * starting: what it holds is enrichment and fails soft (principle 3). The
 * vector index's spaces are the plugins' own, made when they first use them.
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
          log("conversation store reachable, ready");
          emit?.({ kind: "system.recovered", area: "memory-store" });
        }
        resolve();
      } catch (err) {
        if (!failing) {
          log(
            `conversation store unreachable, nothing is archived or reopened until it answers (retrying every ${retryMs / 1000}s): ${String(err)}`,
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
