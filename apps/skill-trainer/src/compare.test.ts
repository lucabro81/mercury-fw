import { describe, expect, test } from "bun:test";
import { compareRuns, formatComparison } from "./compare.ts";
import type { RunConditions } from "./conditions.ts";
import type { Split } from "./contract.ts";
import type { RunFile, RunResult } from "./main.ts";

const CONDITIONS: RunConditions = { commit: "c1", clean: true, model: "m", host: "h", skill: "s1", data: "d1" };

/** A result of task `id` in `repeat`, passed or not. */
const result = (id: string, repeat: number, passed: boolean, over: Partial<RunResult> = {}): RunResult => ({
  id,
  split: "test" as Split,
  taskType: id.split("-")[0]!,
  hard: passed ? 1 : 0,
  soft: passed ? 1 : 0,
  checks: [],
  turns: [],
  unmatched: [],
  seconds: 1,
  repeat,
  ...over,
});

/** A run of the tasks `passes` names, each with the pass/fail of every repeat. */
function run(passes: Record<string, boolean[]>, conditions: Partial<RunConditions> = {}): RunFile {
  const results: RunResult[] = [];
  for (const [id, outcomes] of Object.entries(passes)) outcomes.forEach((ok, i) => results.push(result(id, i + 1, ok)));
  return { conditions: { ...CONDITIONS, ...conditions }, results };
}

/** `n` tasks named `prefix-1`…, each passing `k` times out of `k` when `pass`, never otherwise. */
const tasks = (prefix: string, n: number, k: number, pass: boolean) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-${i + 1}`, Array(k).fill(pass) as boolean[]]));

describe("compareRuns", () => {
  test("two identical runs of the same skill: no gain, not distinguishable, and said to be the same skill", () => {
    const a = run({ ...tasks("count", 10, 3, true), ...tasks("list", 10, 3, false) });
    const c = compareRuns(a, a);
    expect(c).toMatchObject({ tasks: 20, gain: 0, lower: 0, upper: 0, verdict: "not distinguishable", sameSkill: true, onlyTest: true });
  });

  test("a candidate passing half the tasks more is a gain, with its bounds around the mean", () => {
    const baseline = run({ ...tasks("count", 20, 3, true), ...tasks("list", 20, 3, false) });
    const candidate = run({ ...tasks("count", 20, 3, true), ...tasks("list", 20, 3, true) }, { skill: "s2" });
    const c = compareRuns(baseline, candidate);
    expect(c.gain).toBe(0.5);
    expect(c.verdict).toBe("gain");
    expect(c.lower).toBeGreaterThan(0.3);
    expect(c.upper).toBeLessThanOrEqual(0.7);
    expect(c.sameSkill).toBe(false);
  });

  test("a candidate failing half the tasks more is worse, every task that dropped listed, the largest drop first", () => {
    const baseline = run({ ...tasks("count", 20, 2, true), "list-1": [true, true], "list-2": [true, false] });
    const candidate = run({ ...tasks("count", 10, 2, true), ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`count-${i + 11}`, [false, false]])), "list-1": [true, false], "list-2": [true, false] }, { skill: "s2" });
    const c = compareRuns(baseline, candidate);
    expect(c.verdict).toBe("worse");
    expect(c.worse[0]).toEqual({ id: "count-11", taskType: "count", baseline: 1, candidate: 0 });
    expect(c.worse.at(-1)).toEqual({ id: "list-1", taskType: "list", baseline: 1, candidate: 0.5 });
    expect(c.worse).toHaveLength(11);
  });

  test("a task's score is the fraction of its repeats that passed", () => {
    const baseline = run({ "count-1": [true, false, false, true] });
    const candidate = run({ "count-1": [true, true, true, true] }, { skill: "s2" });
    expect(compareRuns(baseline, candidate)).toMatchObject({ gain: 0.5, repeats: { baseline: 4, candidate: 4 } });
  });

  test("the gain per task type", () => {
    const baseline = run({ ...tasks("count", 4, 1, false), ...tasks("list", 4, 1, true) });
    const candidate = run({ ...tasks("count", 4, 1, true), ...tasks("list", 4, 1, true) }, { skill: "s2" });
    expect(compareRuns(baseline, candidate).byType).toEqual([
      { taskType: "count", tasks: 4, gain: 1 },
      { taskType: "list", tasks: 4, gain: 0 },
    ]);
  });

  test("the same two files always give the same answer", () => {
    const baseline = run({ ...tasks("count", 15, 3, true), ...tasks("list", 15, 3, false), "x-1": [true, false, true] });
    const candidate = run({ ...tasks("count", 15, 3, true), ...tasks("list", 10, 3, true), ...tasks("odd", 5, 3, false), "x-1": [false, false, true] }, { skill: "s2" });
    expect(compareRuns(baseline, candidate)).toEqual(compareRuns(baseline, candidate));
  });

  test("only the tasks both runs have are compared; the others are named", () => {
    const baseline = run({ "count-1": [true], "count-2": [false], "only-base": [true] });
    const candidate = run({ "count-1": [true], "count-2": [true], "only-cand": [false] }, { skill: "s2" });
    expect(compareRuns(baseline, candidate)).toMatchObject({ tasks: 2, gain: 0.5, missing: { baseline: ["only-base"], candidate: ["only-cand"] } });
  });

  test("a comparison on tasks outside the test split says so", () => {
    const baseline: RunFile = { conditions: CONDITIONS, results: [result("count-1", 1, true, { split: "train" })] };
    expect(compareRuns(baseline, baseline).onlyTest).toBe(false);
  });

  test("results of tasks that couldn't run are counted, as failures", () => {
    const baseline = run({ "count-1": [true], "count-2": [true] });
    const candidate: RunFile = { conditions: { ...CONDITIONS, skill: "s2" }, results: [result("count-1", 1, true), result("count-2", 1, false, { error: "model unreachable" })] };
    expect(compareRuns(baseline, candidate)).toMatchObject({ gain: -0.5, errors: { baseline: 0, candidate: 1 } });
  });

  test("a run on a tree with uncommitted changes is refused, saying so", () => {
    expect(() => compareRuns(run({ "count-1": [true] }), run({ "count-1": [true] }, { clean: false, skill: "s2" }))).toThrow("a run was made on a tree with uncommitted changes, so its commit isn't the code that ran");
  });

  test("runs whose conditions differ in anything but the skill are refused, the differences named", () => {
    expect(() => compareRuns(run({ "count-1": [true] }), run({ "count-1": [true] }, { model: "other", data: "d2" }))).toThrow("model, data");
  });

  test("a run with no conditions (cut short before they were taken) is refused", () => {
    expect(() => compareRuns({ conditions: null, results: [] }, run({ "count-1": [true] }))).toThrow("no conditions");
  });

  test("two runs with no task in common are refused", () => {
    expect(() => compareRuns(run({ "count-1": [true] }), run({ "count-2": [true] }, { skill: "s2" }))).toThrow("no task in common");
  });
});

describe("formatComparison", () => {
  test("the verdict with the gain and its bounds in points, the types, the drops, and what was left out", () => {
    const baseline = run({ "count-1": [true, true], "count-2": [false, false], "list-1": [true, true], "only-base": [true, true] });
    const candidate = run({ "count-1": [true, true], "count-2": [true, true], "list-1": [true, false] }, { skill: "s2" });
    const lines = formatComparison(compareRuns(baseline, candidate, { resamples: 2000 }));
    expect(lines[0]).toBe("3 tasks in common, 2 repeats a task in the baseline, 2 in the candidate");
    expect(lines).toContain("by task type: count +50.0 points (2 tasks), list -50.0 points (1 task)");
    expect(lines).toContain("got worse: list-1 (list) 100% → 50%");
    expect(lines).toContain("left out, only in the baseline: only-base");
    expect(lines[1]).toMatch(/^not distinguishable: mean \+16\.7 points, 95% bounds -\d+\.\d to \+\d+\.\d$/);
  });

  test("a comparison outside the test split, of the same skill, with failed runs, warns about each", () => {
    const train: RunFile = { conditions: CONDITIONS, results: [result("count-1", 1, true, { split: "train" }), result("count-2", 1, false, { error: "stalled" })] };
    const lines = formatComparison(compareRuns(train, train));
    expect(lines).toContain("warning: not every task is in the test split, where a trained skill must be judged");
    expect(lines).toContain("note: both runs used the same skill (an A/A comparison: it shows the noise)");
    expect(lines).toContain("warning: 1 result couldn't run in the baseline and 1 in the candidate, counted as failures");
  });

  test("one repeat and one task are said in the singular", () => {
    const one: RunFile = { conditions: CONDITIONS, results: [result("count-1", 1, true)] };
    expect(formatComparison(compareRuns(one, one))[0]).toBe("1 task in common, 1 repeat a task in the baseline, 1 in the candidate");
  });

  test("a gain is stated by its lower bound, a loss by its upper one, the mean and bounds after", () => {
    const fail = run({ ...tasks("count", 20, 3, true), ...tasks("list", 20, 3, false) });
    const pass = run({ ...tasks("count", 20, 3, true), ...tasks("list", 20, 3, true) }, { skill: "s2" });
    const gain = compareRuns(fail, pass);
    expect(formatComparison(gain)[1]).toBe(`gain of at least +${(gain.lower * 100).toFixed(1)} points (mean +50.0, 95% bounds +${(gain.lower * 100).toFixed(1)} to +${(gain.upper * 100).toFixed(1)})`);
    const loss = compareRuns({ ...pass, conditions: { ...CONDITIONS, skill: "s1" } }, { ...fail, conditions: { ...CONDITIONS, skill: "s2" } });
    expect(formatComparison(loss)[1]).toBe(`worse by at least ${(-loss.upper * 100).toFixed(1)} points (mean -50.0, 95% bounds ${(loss.lower * 100).toFixed(1)} to ${(loss.upper * 100).toFixed(1)})`);
  });

  // A run cut short keeps its conditions and fewer repeats of some tasks; its scores then weigh unevenly.
  test("repeats that differ from task to task, or between the runs, are warned about", () => {
    const even = run({ "count-1": [true, true, true], "count-2": [true, true, true] });
    const cut = run({ "count-1": [true, true, true], "count-2": [true] }, { skill: "s2" });
    const lines = formatComparison(compareRuns(even, cut));
    expect(lines).toContain("warning: tasks were run a different number of times (the baseline 3, the candidate 1 to 3): a run cut short weighs its tasks unevenly");
    const fewer = run({ "count-1": [true], "count-2": [true] }, { skill: "s2" });
    expect(formatComparison(compareRuns(even, fewer))).toContain("warning: tasks were run a different number of times (the baseline 3, the candidate 1): a run cut short weighs its tasks unevenly");
    expect(formatComparison(compareRuns(even, run({ "count-1": [true, false, true], "count-2": [true, true, false] }, { skill: "s2" }))).filter((l) => l.includes("different number of times"))).toEqual([]);
  });

  // A handful of tasks that all moved the same way leave the bootstrap no spread: any gain looks certain.
  test("fewer than 30 tasks in common are warned about, 30 or more aren't", () => {
    const few = run(tasks("count", 3, 1, false));
    const fewBetter = run(tasks("count", 3, 1, true), { skill: "s2" });
    expect(formatComparison(compareRuns(few, fewBetter))).toContain("warning: only 3 tasks in common: fewer than 30 can't tell a gain from noise, whatever the bounds say");
    const many = run(tasks("count", 30, 1, false));
    const manyBetter = run(tasks("count", 30, 1, true), { skill: "s2" });
    expect(formatComparison(compareRuns(many, manyBetter)).filter((l) => l.includes("tasks in common:"))).toEqual([]);
  });
});

