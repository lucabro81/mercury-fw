import { describe, expect, test } from "bun:test";
import { bootstrapMeans, mulberry32 } from "./stats.ts";

describe("mulberry32", () => {
  test("the same seed gives the same draws, in [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const draws = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(draws);
    expect(draws.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  test("another seed gives other draws", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("bootstrapMeans", () => {
  test("as many resampled means as asked, sorted", () => {
    const means = bootstrapMeans([0, 1, 0, 1, 1], 200, mulberry32(3));
    expect(means).toHaveLength(200);
    expect([...means].sort((x, y) => x - y)).toEqual(means);
  });

  test("differences that are all the same resample to that value", () => {
    expect(new Set(bootstrapMeans([0.25, 0.25, 0.25], 50, mulberry32(1)))).toEqual(new Set([0.25]));
  });

  test("every mean lies between the smallest and the largest difference", () => {
    const means = bootstrapMeans([-1, 0, 0.5, 1], 500, mulberry32(9));
    expect(means[0]!).toBeGreaterThanOrEqual(-1);
    expect(means.at(-1)!).toBeLessThanOrEqual(1);
  });
});
