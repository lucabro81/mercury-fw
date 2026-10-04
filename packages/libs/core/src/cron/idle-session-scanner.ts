/**
 * Pure idle-tracking for session persistence: remembers the last
 * activity time per session key and reports which are idle at a given
 * moment. Time is always passed in, never read internally (`Date.now()`
 * lives in the caller, e.g. `src/index.ts`/`idle-session-cron.ts`) — this
 * is what makes `scanIdle`'s threshold behavior exactly testable.
 */
export type IdleSessionScanner = {
  /** Records activity for `key` at `now`, resetting its idle clock. */
  touch(key: string, now: number): void;
  /** Returns every tracked key whose last activity is at least `idleTimeoutMs` before `now`. */
  scanIdle(now: number, idleTimeoutMs: number): string[];
  /** Whether `key` is tracked and idle at `now`; an untracked key isn't idle. */
  isIdle(key: string, now: number, idleTimeoutMs: number): boolean;
  /** Stops tracking `key` — call after a session has been consolidated and its raw transcript discarded. */
  clear(key: string): void;
};

export function createIdleSessionScanner(): IdleSessionScanner {
  const lastActivity = new Map<string, number>();

  return {
    touch(key, now) {
      lastActivity.set(key, now);
    },
    scanIdle(now, idleTimeoutMs) {
      const idle: string[] = [];
      for (const [key, lastSeen] of lastActivity) {
        if (now - lastSeen >= idleTimeoutMs) {
          idle.push(key);
        }
      }
      return idle;
    },
    isIdle(key, now, idleTimeoutMs) {
      const lastSeen = lastActivity.get(key);
      return lastSeen !== undefined && now - lastSeen >= idleTimeoutMs;
    },
    clear(key) {
      lastActivity.delete(key);
    },
  };
}
