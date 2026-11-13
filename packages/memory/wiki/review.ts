/**
 * The wiki's nightly review: raw/ triage, index.md and orphan maintenance, and
 * a contradiction check, as three independent passes (see
 * `self-review-runner.ts` for why they're independent, not one multi-step
 * call). Raw triage and index/orphan each skip when their own cheap check finds
 * nothing to do; the contradiction check has no such check and always runs,
 * which running it at night, when nothing else wants the model, makes
 * affordable.
 *
 * Each pass is a job of its own on the core's queue (`ctx.job`, nobody
 * waiting), so the traces show it as `wiki:review-<pass>`. One that fails, or
 * is dropped because the agent stops, is logged and doesn't stop the others.
 * When it runs is `ctx.daily`'s business (see `index.ts`).
 */
import type { JobUrgency } from "@mercury-fw/plugin-types";

export type ReviewDeps = {
  listRawEntries: () => Promise<string[]>;
  findOrphans: () => Promise<string[]>;
  runRawTriage: (rawEntries: string[]) => Promise<void>;
  runIndexAndOrphan: (orphans: string[]) => Promise<void>;
  runContradictionCheck: () => Promise<void>;
  /** The core's queue (`ctx.job`). */
  job: (name: string, urgency: JobUrgency, fn: () => Promise<void>) => Promise<unknown>;
  log: (msg: string) => void;
};

/** Runs one review: each pass that has something to do, as its own job. */
export async function runReview(deps: ReviewDeps): Promise<void> {
  /** Runs one pass as a job, logging how it failed when it did. */
  async function pass(name: string, label: string, run: (() => Promise<void>) | undefined): Promise<void> {
    if (run === undefined) return;
    try {
      await deps.job(name, "idle", run);
    } catch (err) {
      deps.log(`review ${label} pass failed: ${String(err)}`);
    }
  }

  const [rawEntries, orphans] = await Promise.all([deps.listRawEntries(), deps.findOrphans()]);
  await pass("review-raw", "raw-triage", rawEntries.length > 0 ? () => deps.runRawTriage(rawEntries) : undefined);
  await pass("review-index", "index/orphan", orphans.length > 0 ? () => deps.runIndexAndOrphan(orphans) : undefined);
  await pass("review-contradictions", "contradiction-check", () => deps.runContradictionCheck());
}
