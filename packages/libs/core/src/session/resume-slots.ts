/**
 * Where a confirmed action whose result goes back to the model waits for its
 * session's resumed turn (see `InboundTurn.resumeAfterConfirm`): one per
 * session, taken once. A later confirmation in the same session replaces one
 * not resumed yet, and a result nobody resumes within `ttlMs` (a channel that
 * never asked, a client that never came back) is forgotten, so it can't turn
 * up in a resumed turn long after. In memory, like the confirmations
 * themselves: a restart loses it, and the resumed turn then ends with no answer.
 */
import type { ResumedAction } from "@mercury-fw/confirm-engine";

/** As long as a confirmation token lives (see `confirmation-store.ts`). */
const DEFAULT_TTL_MS = 5 * 60_000;

export type ResumeSlots = {
  /** Keeps `action` for `sessionKey`'s resumed turn. */
  keep(sessionKey: string, action: ResumedAction): void;
  /** Takes what is kept for `sessionKey`, or undefined when nothing (still) is. */
  take(sessionKey: string): ResumedAction | undefined;
  /** How many results are kept, for tests. */
  size(): number;
};

/** Creates the per-session slots; `now` and `ttlMs` are test seams. */
export function createResumeSlots(opts: { now?: () => number; ttlMs?: number } = {}): ResumeSlots {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const slots = new Map<string, { action: ResumedAction; expiresAt: number }>();

  return {
    keep(sessionKey, action) {
      const t = now();
      for (const [key, slot] of slots) if (slot.expiresAt < t) slots.delete(key);
      slots.set(sessionKey, { action, expiresAt: t + ttlMs });
    },
    take(sessionKey) {
      const slot = slots.get(sessionKey);
      slots.delete(sessionKey);
      return slot && slot.expiresAt >= now() ? slot.action : undefined;
    },
    size: () => slots.size,
  };
}
