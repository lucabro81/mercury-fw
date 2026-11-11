/**
 * The wiki self-review cron: runs once nightly (a fixed local hour,
 * hardcoded, no env override — deliberately different from every other
 * interval in this codebase, per an explicit request to keep this one
 * out of runtime configurability), running raw/ triage, index.md/orphan
 * maintenance, and a contradiction check as three independent sub-passes
 * (see `self-review-runner.ts` for why they're independent, not one
 * multi-step call). Raw-triage and index/orphan each skip when their own
 * cheap pre-check finds nothing to do; the contradiction check has no
 * such pre-check and always runs on a triggered tick — running the whole
 * thing at night, when nothing else contends for the shared local model,
 * is what makes that affordable.
 *
 * This file owns only the scheduling/orchestration mechanics — vault
 * access and the actual LLM calls are injected, same separation
 * `idle-session-cron.ts` uses for session storage and the LLM summarizer.
 */
import type { TraceInput } from "../traces/tracer.ts";

export type SelfReviewTickDeps = {
  listRawEntries: () => Promise<string[]>;
  findOrphans: () => Promise<string[]>;
  runRawTriage: (rawEntries: string[]) => Promise<void>;
  runIndexAndOrphan: (orphans: string[]) => Promise<void>;
  runContradictionCheck: () => Promise<void>;
  log?: (msg: string) => void;
  /** Where each pass's `review.pass` event goes (#23), all under one job id per tick. */
  emit?: (input: TraceInput) => void;
  /** Test seam for the passes' durations; defaults to `Date.now`. */
  clock?: () => number;
  /** Test seam for the tick's job id; defaults to a random UUID. */
  newJobId?: () => string;
};

/**
 * Runs one nightly pass: raw-triage and index/orphan each run only if
 * their own cheap signal found something; the contradiction check always
 * runs, since nothing cheap can tell it whether there's anything to find.
 * Each sub-pass is wrapped in its own try/catch — one failing must not
 * stop the other two from running in the same pass (hard-won convention:
 * one bad tick can't take down the rest of Mercury).
 */
export async function runSelfReviewTick(deps: SelfReviewTickDeps): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const clock = deps.clock ?? Date.now;
  const job = (deps.newJobId ?? (() => crypto.randomUUID()))();

  /** Runs one pass (or records it as skipped), logging and emitting how it went. */
  async function pass(name: "raw" | "index" | "contradictions", label: string, run: (() => Promise<void>) | undefined): Promise<void> {
    if (run === undefined) {
      deps.emit?.({ kind: "review.pass", job, pass: name, outcome: "skipped" });
      return;
    }
    const startedAt = clock();
    try {
      await run();
      deps.emit?.({ kind: "review.pass", job, pass: name, outcome: "done", durationMs: clock() - startedAt });
    } catch (err) {
      log(`self-review ${label} pass failed: ${String(err)}`);
      deps.emit?.({
        kind: "review.pass",
        job,
        pass: name,
        outcome: "failed",
        durationMs: clock() - startedAt,
        args: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const [rawEntries, orphans] = await Promise.all([deps.listRawEntries(), deps.findOrphans()]);
  await pass("raw", "raw-triage", rawEntries.length > 0 ? () => deps.runRawTriage(rawEntries) : undefined);
  await pass("index", "index/orphan", orphans.length > 0 ? () => deps.runIndexAndOrphan(orphans) : undefined);
  await pass("contradictions", "contradiction-check", () => deps.runContradictionCheck());
}

/** 3 AM local time — hardcoded on purpose, see file header. */
export const SELF_REVIEW_HOUR = 3;
/** How often to check whether it's time to run — mirrors idle-session-cron's
 * check-vs-timeout split, hardcoded for the same reason as the hour above. */
export const SELF_REVIEW_CHECK_INTERVAL_MS = 15 * 60_000;

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export type SelfReviewCron = { stop: () => void };

/**
 * Checks every `opts.checkIntervalMs` whether the current local hour
 * matches `opts.hour` and today hasn't run yet; if so, runs one tick.
 * `lastRunDate` is in-memory only — if the process restarts mid-window it
 * just waits for tomorrow's, which is fine, nothing here needs to survive
 * a restart. `opts.now`/`opts.hour`/`opts.checkIntervalMs` exist purely as
 * test seams; production (`index.ts`) never overrides them.
 */
export function startSelfReviewCron(deps: SelfReviewTickDeps, opts: { hour?: number; checkIntervalMs?: number; now?: () => Date } = {}): SelfReviewCron {
  const hour = opts.hour ?? SELF_REVIEW_HOUR;
  const checkIntervalMs = opts.checkIntervalMs ?? SELF_REVIEW_CHECK_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string) => console.error(msg));
  let lastRunDate: string | null = null;

  const interval = setInterval(() => {
    const current = now();
    if (current.getHours() !== hour) return;
    const today = localDateKey(current);
    if (lastRunDate === today) return;
    lastRunDate = today;

    runSelfReviewTick(deps).catch((err) => {
      log(`self-review cron tick failed: ${String(err)}`);
    });
  }, checkIntervalMs);

  return { stop: () => clearInterval(interval) };
}
