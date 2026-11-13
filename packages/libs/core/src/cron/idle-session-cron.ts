/**
 * The idle-session cron loop: periodically sweeps for sessions idle past the
 * configured timeout and closes each one (`deps.closeSession`), then tells
 * the plugins (`deps.onClosed`, their `onSessionClose`): what a session leaves
 * behind is theirs to keep (the memory plugin's summary, say). Every
 * dependency is injected: this file owns only the sweep and its interval.
 */
import type { IdleSessionScanner } from "./idle-session-scanner.ts";
import type { Message } from "../session/history.ts";
import type { TraceInput } from "../traces/tracer.ts";

export type IdleSession = { key: string; userId: string; messages: Message[] };

export type IdleSessionSweepDeps = {
  /** Looks up a session's current content by key; `undefined` if it's already gone (e.g. closed by something else in the meantime). */
  getSession: (key: string) => IdleSession | undefined;
  /** Discards the session's conversation. */
  closeSession: (key: string) => void;
  /**
   * Runs `fn` while nothing else touches that session (the core's session
   * lock, shared with the turn runner). Absent, the work runs directly.
   */
  withSession?: (key: string, fn: () => Promise<void>) => Promise<void>;
  /** Told about each session once it's closed, with the messages it was closed with, outside the lock (the plugins' `onSessionClose`). A throw is logged. */
  onClosed?: (session: IdleSession) => void;
  log?: (msg: string) => void;
  /** Where each `session.closed` event goes (#23). */
  emit?: (input: TraceInput) => void;
};

/**
 * Runs one sweep at `now`: every session `scanner` reports idle (past
 * `idleTimeoutMs`) is closed, under `withSession`, and cleared from
 * `scanner`; a session a turn ran in by the time the sweep holds it isn't
 * idle any more and stays open. A failure is logged and never stops the sweep
 * from processing the others (hard-won convention: one bad tick can't take
 * down the rest of Mercury).
 */
export async function runIdleSessionSweep(
  scanner: IdleSessionScanner,
  now: number,
  idleTimeoutMs: number,
  deps: IdleSessionSweepDeps,
): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const withSession = deps.withSession ?? ((_key: string, fn: () => Promise<void>) => fn());

  for (const key of scanner.scanIdle(now, idleTimeoutMs)) {
    try {
      let closed: IdleSession | undefined;
      await withSession(key, async () => {
        // A turn may have run while the sweep waited for the session.
        if (!scanner.isIdle(key, now, idleTimeoutMs)) return;
        const session = deps.getSession(key);
        scanner.clear(key);
        if (!session) return;
        deps.closeSession(key);
        closed = session;
        deps.emit?.({ kind: "session.closed", session: key, person: session.userId, messages: session.messages.length });
      });
      if (closed) deps.onClosed?.(closed);
    } catch (err) {
      log(`idle session sweep failed for ${key}: ${String(err)}`);
    }
  }
}

export type IdleSessionCron = { stop: () => void };

/** Starts the periodic sweep on `opts.checkIntervalMs`, gated on `opts.idleTimeoutMs`. `stop()` halts it. */
export function startIdleSessionCron(
  scanner: IdleSessionScanner,
  deps: IdleSessionSweepDeps,
  opts: { idleTimeoutMs: number; checkIntervalMs: number },
): IdleSessionCron {
  // A sweep slower than the interval would otherwise overlap the next one,
  // and both would close the same idle session.
  let sweeping = false;
  const interval = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    runIdleSessionSweep(scanner, Date.now(), opts.idleTimeoutMs, deps)
      .catch((err) => {
        (deps.log ?? ((msg: string) => console.error(msg)))(`idle session cron tick failed: ${String(err)}`);
      })
      .finally(() => {
        sweeping = false;
      });
  }, opts.checkIntervalMs);

  return {
    stop: () => clearInterval(interval),
  };
}
