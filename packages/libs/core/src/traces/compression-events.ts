/**
 * The `history.compressed` event: Layer 1 folding a conversation's older
 * messages into a summary happens inside a turn, on the model, and costs the
 * person waiting for the answer. This wraps the history's `summarize` so each
 * compression says how much it folded and how long it took, without the
 * history knowing about traces.
 */
import type { Message } from "../session/history.ts";
import type { TraceInput } from "./tracer.ts";

/** `summarize`, emitting a `history.compressed` event through `deps.emit` for each call; a failure is emitted and rethrown. */
export function withCompressionEvents(
  summarize: (messages: Message[]) => Promise<string>,
  deps: { emit: (input: TraceInput) => void; now: () => number },
): (messages: Message[]) => Promise<string> {
  return async (messages) => {
    const startedAt = deps.now();
    const charsBefore = messages.reduce((sum, m) => sum + m.content.length, 0);
    try {
      const summary = await summarize(messages);
      deps.emit({
        kind: "history.compressed",
        messages: messages.length,
        charsBefore,
        charsAfter: summary.length,
        durationMs: deps.now() - startedAt,
        outcome: "done",
      });
      return summary;
    } catch (err) {
      deps.emit({
        kind: "history.compressed",
        messages: messages.length,
        charsBefore,
        durationMs: deps.now() - startedAt,
        outcome: "failed",
        args: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  };
}
