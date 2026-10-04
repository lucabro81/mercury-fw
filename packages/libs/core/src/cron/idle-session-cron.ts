/**
 * The session-persistence cron loop: periodically sweeps for sessions idle past the
 * configured timeout, summarizes each one (episodic-summarizer.ts),
 * writes the result to Qdrant (episodic-store.ts), and discards the raw
 * transcript (`deps.closeSession`). Every dependency is injected — this
 * file owns only the sweep/interval mechanics, not session storage, the
 * LLM call, or Qdrant itself.
 */
import type { IdleSessionScanner } from "./idle-session-scanner.ts";
import type { Message } from "../session/history.ts";
import type { EpisodicSummary } from "../memory/episodic-store.ts";
import type { SemanticFact } from "../session/semantic-fact-extractor.ts";
import type { SemanticFactEntry } from "../memory/semantic-facts-store.ts";

export type IdleSession = { key: string; userId: string; messages: Message[] };

/**
 * Dependencies for `captureSessionToMemory` — a subset of
 * `IdleSessionSweepDeps`, without `getSession`/`closeSession`: this
 * function never decides *whether* a session should be captured or
 * whether it should be closed afterwards, only *how* to capture a given
 * slice of messages. Reused by the idle sweep below (final capture +
 * close) and, without touching this file's own tests, by the two
 * mid-conversation triggers wired in `index.ts` (message-count threshold,
 * Layer 1 compression) — neither of which closes the session.
 */
export type CaptureDeps = {
  summarize: (messages: Message[]) => Promise<string>;
  store: (entry: EpisodicSummary) => Promise<void>;
  /**
   * Semantic fact extraction/consolidation (D-22/D-34) — an enrichment on
   * top of the episodic summary above, not a required part of it: omit
   * all three and capture behaves exactly as before. When present, a
   * failure here is logged and never propagates — the episodic write
   * already succeeded and is the source of truth being preserved, same
   * "system must work when this enrichment is absent" boundary as every
   * other Layer 2/3 store in Mercury.
   */
  extractFacts?: (messages: Message[]) => Promise<SemanticFact[]>;
  storeFact?: (entry: SemanticFactEntry) => Promise<void>;
  consolidateFact?: (userId: string, topic: string) => Promise<void>;
  log?: (msg: string) => void;
};

/**
 * Summarizes+stores an episodic entry for `messages`, then (when the
 * semantic deps are provided) extracts and consolidates semantic facts —
 * the one place this logic lives, shared by every capture trigger. A
 * failure summarizing/storing propagates to the caller (it decides what
 * "capture failed" means for its own trigger — e.g. the idle sweep below
 * leaves the session tracked for retry and skips `closeSession`); a
 * failure in the semantic enrichment layer is caught and logged here,
 * never propagated, since it must never undo an episodic write that
 * already succeeded.
 */
export async function captureSessionToMemory(
  userId: string,
  sessionKey: string,
  messages: Message[],
  now: number,
  deps: CaptureDeps,
): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg));

  const summary = await deps.summarize(messages);
  const timestamp = new Date(now).toISOString();
  await deps.store({ userId, sessionKey, summary, timestamp });

  if (deps.extractFacts && deps.storeFact && deps.consolidateFact) {
    try {
      const facts = await deps.extractFacts(messages);
      for (const fact of facts) {
        try {
          await deps.storeFact({ userId, topic: fact.topic, value: fact.value, timestamp });
          await deps.consolidateFact(userId, fact.topic);
        } catch (err) {
          log(`semantic fact consolidation failed for ${sessionKey}/${fact.topic}: ${String(err)}`);
        }
      }
    } catch (err) {
      log(`semantic fact extraction failed for ${sessionKey}: ${String(err)}`);
    }
  }
}

export type IdleSessionSweepDeps = CaptureDeps & {
  /** Looks up a session's current content by key; `undefined` if it's already gone (e.g. closed by something else in the meantime). */
  getSession: (key: string) => IdleSession | undefined;
  /** Discards the session's raw transcript — called only after a successful summarize+store. */
  closeSession: (key: string) => void;
  /**
   * Runs one session's capture and close while nothing else touches that
   * session (the core's session lock, shared with the turn runner). Absent,
   * the work runs directly.
   */
  withSession?: (key: string, fn: () => Promise<void>) => Promise<void>;
};

/**
 * Runs one sweep at `now`: every session `scanner` reports idle (past
 * `idleTimeoutMs`) gets captured (`captureSessionToMemory`) and closed,
 * then cleared from `scanner`. A failure capturing is logged and leaves
 * that session's tracking untouched (retried on the next sweep) — it must
 * never stop the sweep from processing the others (hard-won convention:
 * one bad tick can't take down the rest of Mercury).
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
      await withSession(key, async () => {
        // A turn may have run while the sweep waited for the session.
        if (!scanner.isIdle(key, now, idleTimeoutMs)) return;
        const session = deps.getSession(key);
        if (!session) {
          scanner.clear(key);
          return;
        }

        await captureSessionToMemory(session.userId, key, session.messages, now, deps);

        deps.closeSession(key);
        scanner.clear(key);
      });
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
  // and both would capture the same idle session.
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
