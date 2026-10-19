import { describe, expect, test } from "bun:test";
import { runProgram, type CompareOptions, type RunOptions } from "./program.ts";
import type { TrainOptions } from "./train.ts";
import type { UpdateOptions } from "./update-skillopt.ts";

/** Runs `argv` with handlers returning `code` (or throwing `throws`), collecting what each got and what was written. */
async function parse(argv: string[], { code = 0, throws }: { code?: number; throws?: string } = {}) {
  let received: RunOptions | undefined;
  let compared: CompareOptions | undefined;
  let trained: TrainOptions | undefined;
  let updated: UpdateOptions | undefined;
  let err = "";
  const answer = async () => {
    if (throws !== undefined) throw new Error(throws);
    return code;
  };
  const exit = await runProgram(
    argv,
    {
      run: async (opts) => {
        received = opts;
        return answer();
      },
      compare: async (opts) => {
        compared = opts;
        return answer();
      },
      train: async (opts) => {
        trained = opts;
        return answer();
      },
      updateSkillOpt: async (opts) => {
        updated = opts;
        return answer();
      },
    },
    { writeErr: (s) => void (err += s), writeOut: () => {} },
  );
  return { received, compared, trained, updated, exit, err };
}

describe("skill-trainer run", () => {
  test("a plugin alone: every task, its own skill, a printed report", async () => {
    const { received, exit } = await parse(["run", "jira"]);
    expect(received).toEqual({ plugin: "jira" });
    expect(exit).toBe(0);
  });

  test("a candidate skill, a split, tasks and a JSON file for the results", async () => {
    const { received } = await parse(["run", "jira", "--skill", "best_skill.md", "--split", "val", "--task", "a", "b", "--json", "out/results.json"]);
    expect(received).toEqual({ plugin: "jira", skill: "best_skill.md", split: "val", ids: ["a", "b"], json: "out/results.json" });
  });

  test("--repeat takes a whole number of runs", async () => {
    const { received } = await parse(["run", "jira", "--repeat", "3"]);
    expect(received).toEqual({ plugin: "jira", repeat: 3 });
  });

  test("a --repeat that isn't a whole number of at least 1 is refused before anything runs", async () => {
    for (const value of ["0", "-1", "2.5", "three"]) {
      const { received, exit, err } = await parse(["run", "jira", "--repeat", value]);
      expect([received, exit]).toEqual([undefined, 1]);
      expect(err).toContain("--repeat");
    }
  });

  test("--skillopt-out: a folder for what SkillOpt reads of the run", async () => {
    const { received } = await parse(["run", "jira", "--task", "a", "--skillopt-out", "out/step/rollout"]);
    expect(received).toEqual({ plugin: "jira", ids: ["a"], skilloptOut: "out/step/rollout" });
  });

  test("--skillopt-out with --repeat is refused: SkillOpt runs every task once a step", async () => {
    const { received, exit, err } = await parse(["run", "jira", "--repeat", "2", "--skillopt-out", "out"]);
    expect([received, exit]).toEqual([undefined, 1]);
    expect(err).toContain("cannot be used with option '--repeat <n>'");
  });

  test("a split that isn't one is refused before anything runs", async () => {
    const { received, exit, err } = await parse(["run", "jira", "--split", "dev"]);
    expect(received).toBeUndefined();
    expect(exit).not.toBe(0);
    expect(err).toContain("Allowed choices are train, val, test");
  });

  test("a missing plugin is refused", async () => {
    const { received, exit, err } = await parse(["run"]);
    expect(received).toBeUndefined();
    expect(exit).not.toBe(0);
    expect(err).toContain("missing required argument 'plugin'");
  });

  test("the handler's exit code is the command's", async () => {
    expect((await parse(["run", "jira"], { code: 3 })).exit).toBe(3);
  });

  test("an error the handler throws is written and exits 1", async () => {
    const { exit, err } = await parse(["run", "jira"], { throws: "the jira plugin has no training data" });
    expect(exit).toBe(1);
    expect(err).toBe("the jira plugin has no training data\n");
  });

  test("no arguments prints the help as an error", async () => {
    const { exit, err } = await parse([]);
    expect(exit).toBe(1);
    expect(err).toContain("Usage: skill-trainer");
  });
});

describe("skill-trainer compare", () => {
  test("a baseline's results file and a candidate's", async () => {
    const { compared, exit } = await parse(["compare", "results/baseline.json", "results/candidate.json"]);
    expect(compared).toEqual({ baseline: "results/baseline.json", candidate: "results/candidate.json" });
    expect(exit).toBe(0);
  });

  test("one file alone is refused", async () => {
    const { compared, exit, err } = await parse(["compare", "results/baseline.json"]);
    expect([compared, exit]).toEqual([undefined, 1]);
    expect(err).toContain("missing required argument 'candidate'");
  });
});

describe("skill-trainer train", () => {
  test("a plugin alone: the defaults, a new folder under results/", async () => {
    const { trained, exit } = await parse(["train", "jira"]);
    expect([trained, exit]).toEqual([{ plugin: "jira" }, 0]);
  });

  test("a config over the defaults and an output folder", async () => {
    const { trained } = await parse(["train", "jira", "--config", "train.yaml", "--out", "out/jira"]);
    expect(trained).toEqual({ plugin: "jira", config: "train.yaml", out: "out/jira" });
  });

  test("SkillOpt's exit code is the command's", async () => {
    expect((await parse(["train", "jira"], { code: 2 })).exit).toBe(2);
  });
});

describe("skill-trainer update-skillopt", () => {
  test("latest main by default, or the --ref given", async () => {
    expect((await parse(["update-skillopt"])).updated).toEqual({});
    expect((await parse(["update-skillopt", "--ref", "v0.3.0"])).updated).toEqual({ ref: "v0.3.0" });
  });
});
