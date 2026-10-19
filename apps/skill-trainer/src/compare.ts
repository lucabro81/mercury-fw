/**
 * `skill-trainer compare`: whether a candidate skill does better than a
 * baseline, from two runs' JSON files, by the procedure in the README's
 * "Measuring a gain". A task's score is the fraction of its repeats that
 * passed; the gain is the mean of the per-task differences; its 95% bounds
 * come from a bootstrap over tasks (seeded: the same files give the same
 * answer). A gain is claimed only when the lower bound is above zero, and a
 * loss only when the upper bound is below it.
 */
import { conditionsDiffer } from "./conditions.ts";
import type { RunFile, RunResult } from "./main.ts";
import { bootstrapMeans, mulberry32 } from "./stats.ts";

export type Verdict = "gain" | "not distinguishable" | "worse";

export type Comparison = {
  /** The tasks both runs have, the ones compared. */
  tasks: number;
  /** The most repeats a task has in each run. */
  repeats: { baseline: number; candidate: number };
  /** The mean per-task difference, candidate minus baseline (a fraction: 0.05 is 5 points). */
  gain: number;
  /** The one-sided 95% bounds of the gain. */
  lower: number;
  upper: number;
  verdict: Verdict;
  /** Whether both runs used the same skill: an A/A comparison, the noise alone. */
  sameSkill: boolean;
  /** Whether every compared task is in the test split. */
  onlyTest: boolean;
  byType: Array<{ taskType: string; tasks: number; gain: number }>;
  /** Every task whose score dropped, the largest drop first. */
  worse: Array<{ id: string; taskType: string; baseline: number; candidate: number }>;
  /** Tasks only one run has, left out. */
  missing: { baseline: string[]; candidate: string[] };
  /** Results of tasks that couldn't run, counted as failures. */
  errors: { baseline: number; candidate: number };
};

type TaskScore = { taskType: string; split: string; score: number; repeats: number };

/** Each task's score in `results`: the fraction of its repeats that passed, in the order the tasks first appear. */
function scores(results: RunResult[]): Map<string, TaskScore> {
  const byTask = new Map<string, { taskType: string; split: string; passed: number; runs: number }>();
  for (const r of results) {
    const t = byTask.get(r.id) ?? { taskType: r.taskType, split: r.split, passed: 0, runs: 0 };
    t.passed += r.hard;
    t.runs++;
    byTask.set(r.id, t);
  }
  return new Map([...byTask].map(([id, t]) => [id, { taskType: t.taskType, split: t.split, score: t.passed / t.runs, repeats: t.runs }]));
}

/** `baseline` against `candidate`. Throws when either has no conditions, when
 * their conditions differ in anything but the skill, or when they share no task. */
export function compareRuns(baseline: RunFile, candidate: RunFile, { resamples = 10000, seed = 246 } = {}): Comparison {
  if (baseline.conditions === null || candidate.conditions === null) {
    throw new Error("a run has no conditions: it was cut short before they were taken, or it was written by an older skill-trainer");
  }
  const differ = conditionsDiffer(baseline.conditions, candidate.conditions);
  if (differ.length > 0) throw new Error(`the runs weren't made under the same conditions, so their difference isn't the skill's: ${differ.join(", ")}`);
  const base = scores(baseline.results);
  const cand = scores(candidate.results);
  const common = [...base.keys()].filter((id) => cand.has(id));
  if (common.length === 0) throw new Error("the runs have no task in common");

  const diffs = common.map((id) => cand.get(id)!.score - base.get(id)!.score);
  const gain = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const means = bootstrapMeans(diffs, resamples, mulberry32(seed));
  const lower = means[Math.floor(0.05 * resamples)]!;
  const upper = means[Math.ceil(0.95 * resamples) - 1]!;

  const types = new Map<string, number[]>();
  common.forEach((id, i) => types.set(base.get(id)!.taskType, [...(types.get(base.get(id)!.taskType) ?? []), diffs[i]!]));
  const worse = common
    .map((id) => ({ id, taskType: base.get(id)!.taskType, baseline: base.get(id)!.score, candidate: cand.get(id)!.score }))
    .filter((t) => t.candidate < t.baseline)
    .sort((a, b) => b.baseline - b.candidate - (a.baseline - a.candidate));

  return {
    tasks: common.length,
    repeats: { baseline: Math.max(...common.map((id) => base.get(id)!.repeats)), candidate: Math.max(...common.map((id) => cand.get(id)!.repeats)) },
    gain,
    lower,
    upper,
    verdict: lower > 0 ? "gain" : upper < 0 ? "worse" : "not distinguishable",
    sameSkill: baseline.conditions.skill === candidate.conditions.skill,
    onlyTest: common.every((id) => base.get(id)!.split === "test"),
    byType: [...types].sort(([a], [b]) => a.localeCompare(b)).map(([taskType, d]) => ({ taskType, tasks: d.length, gain: d.reduce((a, b) => a + b, 0) / d.length })),
    worse,
    missing: { baseline: [...base.keys()].filter((id) => !cand.has(id)), candidate: [...cand.keys()].filter((id) => !base.has(id)) },
    errors: { baseline: baseline.results.filter((r) => r.error !== undefined).length, candidate: candidate.results.filter((r) => r.error !== undefined).length },
  };
}

/** A fraction as signed points, one decimal. */
const points = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const percent = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The comparison as the lines `compare` prints. */
export function formatComparison(c: Comparison): string[] {
  const lines = [`${plural(c.tasks, "task")} in common, ${plural(c.repeats.baseline, "repeat")} a task in the baseline, ${c.repeats.candidate} in the candidate`];
  lines.push(`${c.verdict}: ${points(c.gain)} points, 95% bounds ${points(c.lower)} to ${points(c.upper)}`);
  lines.push(`by task type: ${c.byType.map((t) => `${t.taskType} ${points(t.gain)} points (${plural(t.tasks, "task")})`).join(", ")}`);
  for (const t of c.worse) lines.push(`got worse: ${t.id} (${t.taskType}) ${percent(t.baseline)} → ${percent(t.candidate)}`);
  if (c.missing.baseline.length > 0) lines.push(`left out, only in the baseline: ${c.missing.baseline.join(", ")}`);
  if (c.missing.candidate.length > 0) lines.push(`left out, only in the candidate: ${c.missing.candidate.join(", ")}`);
  if (!c.onlyTest) lines.push("warning: not every task is in the test split, where a trained skill must be judged");
  if (c.sameSkill) lines.push("note: both runs used the same skill (an A/A comparison: it shows the noise)");
  if (c.errors.baseline + c.errors.candidate > 0) {
    lines.push(`warning: ${plural(c.errors.baseline, "result")} couldn't run in the baseline and ${c.errors.candidate} in the candidate, counted as failures`);
  }
  return lines;
}
