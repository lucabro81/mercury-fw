/**
 * The statistics a skill comparison rests on, shared by `compare` and the
 * simulation in `scripts/power.ts` that sizes it: a seeded random source, so
 * the same inputs give the same answer, and a bootstrap over tasks.
 */

/** A seeded PRNG (mulberry32): draws in [0, 1), the same for the same seed. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The means of `resamples` resamplings of `diffs` with replacement, sorted:
 * the bootstrap distribution of their mean, drawn from `rand`. */
export function bootstrapMeans(diffs: number[], resamples: number, rand: () => number): number[] {
  const n = diffs.length;
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rand() * n)]!;
    means.push(s / n);
  }
  return means.sort((a, b) => a - b);
}
