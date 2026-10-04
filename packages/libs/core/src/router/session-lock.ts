/**
 * One-at-a-time work per session key: what keeps two turns of the same
 * conversation (two browser tabs, a double submit on HTTP) from running on one
 * `SessionHistory` at once, and the idle sweep from closing a session while a
 * turn is on it. Different keys never wait on each other, so different people,
 * and different conversations of one person, still run in parallel.
 *
 * Each key holds a promise chain only while something runs or waits on it;
 * the entry is dropped once the chain drains, so the map doesn't grow with
 * every conversation ever seen.
 */

export type SessionLock = {
  /**
   * Runs `fn` once every earlier run on `key` has settled. If `signal` is
   * aborted before `fn` starts, `fn` never starts and the result is
   * `undefined` right away, while the runs queued after it keep their place.
   * A rejection reaches this caller only, never the runs queued after it.
   */
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined>;
  /** The keys something is running or waiting on, for tests and diagnostics. */
  activeKeys(): string[];
};

/** Builds an empty lock; the core keeps one per instance. */
export function createSessionLock(): SessionLock {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
      if (signal?.aborted) return Promise.resolve(undefined);
      const previous = tails.get(key) ?? Promise.resolve();
      let started = false;
      const result = previous.then(() => {
        if (signal?.aborted) return undefined;
        started = true;
        return fn();
      });
      const tail = result.catch(() => {});
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      if (signal === undefined) return result;
      // Released as soon as it's aborted while waiting, not when the run
      // ahead of it settles; once `fn` started, its own handling of the
      // signal decides.
      return new Promise<T | undefined>((resolve, reject) => {
        const onAbort = () => {
          if (!started) resolve(undefined);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        result.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
    activeKeys: () => [...tails.keys()],
  };
}
