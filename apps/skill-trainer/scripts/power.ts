// `bun scripts/power.ts`: the table in the README's "Measuring a gain".
// Monte Carlo of the skill comparison: how often a paired, per-task comparison
// detects a real gain (power) and claims one that isn't there (false positives),
// for a number of test tasks, repeats per skill, a baseline pass rate and a gain.
//
// Model: each task has its own baseline pass probability (tasks differ a lot:
// some always pass, some rarely), drawn from a Beta with the given mean; the
// candidate adds `gain` points to every task, capped at 1, scaled so that the
// mean gain over tasks is `gain`. Each skill runs every task `k` times; a task's
// score is its pass fraction. Decision: the one-sided 95% lower bound of the
// mean per-task difference (bootstrap over tasks) is above 0.

import { bootstrapMeans, mulberry32 } from "../src/stats.ts";

const rand = mulberry32(246);

/** A Gamma(shape, 1) draw (Marsaglia–Tsang), for the Beta. */
function gamma(shape: number): number {
  if (shape < 1) return gamma(shape + 1) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      const u1 = rand(), u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
/** A Beta draw with mean `m` and concentration `k` (low k: tasks very different from each other). */
const beta = (m: number, k: number) => {
  const a = gamma(m * k), b = gamma((1 - m) * k);
  return a / (a + b);
};

/** The pass fraction of `k` runs of a task passing with probability `p`. */
const runs = (p: number, k: number) => {
  let pass = 0;
  for (let i = 0; i < k; i++) if (rand() < p) pass++;
  return pass / k;
};

/** Whether the comparison calls a gain: bootstrap lower bound of the mean difference above 0. */
function detects(diffs: number[], resamples = 400): boolean {
  return bootstrapMeans(diffs, resamples, rand)[Math.floor(0.05 * resamples)]! > 0;
}

/** The fraction of `trials` simulated comparisons that call a gain. */
function rate(n: number, k: number, base: number, gain: number, trials = 600): number {
  let hits = 0;
  for (let t = 0; t < trials; t++) {
    const diffs: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = beta(base, 2);
      const q = Math.min(1, p + (gain * (1 - p)) / (1 - base));
      diffs.push(runs(q, k) - runs(p, k));
    }
    if (detects(diffs)) hits++;
  }
  return hits / trials;
}

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
for (const base of [0.9, 0.7]) {
  console.log(`\nbaseline pass rate ${base * 100}%`);
  console.log("tasks  repeats | false pos. | power +5  +10  +15  +20 points");
  for (const n of [16, 30, 50, 80, 120]) {
    for (const k of [1, 3, 5]) {
      const row = [0.05, 0.1, 0.15, 0.2].map((g) => (base + g <= 1 ? pct(rate(n, k, base, g)) : "   -"));
      console.log(`${String(n).padStart(5)}  ${String(k).padStart(7)} |       ${pct(rate(n, k, base, 0))} |      ${row.join(" ")}`);
    }
  }
}
