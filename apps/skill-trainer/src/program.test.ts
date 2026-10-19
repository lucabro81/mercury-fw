import { describe, expect, test } from "bun:test";
import { runProgram, type RunOptions } from "./program.ts";

/** Runs `argv` with a `run` handler returning `code` (or throwing `throws`), collecting what it got and what was written. */
async function parse(argv: string[], { code = 0, throws }: { code?: number; throws?: string } = {}) {
  let received: RunOptions | undefined;
  let err = "";
  const exit = await runProgram(
    argv,
    {
      run: async (opts) => {
        received = opts;
        if (throws !== undefined) throw new Error(throws);
        return code;
      },
    },
    { writeErr: (s) => void (err += s), writeOut: () => {} },
  );
  return { received, exit, err };
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
