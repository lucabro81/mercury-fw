import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePin, PIN_PATH, PYTHON_DIR, skilloptArgv } from "./skillopt.ts";

const COMMIT = "1a44050fc53aa4938a7a3927b6cca550491bfe51";

describe("parsePin", () => {
  test("the repository and the full commit SkillOpt is pinned to", () => {
    expect(parsePin(JSON.stringify({ repository: "https://github.com/microsoft/SkillOpt", commit: COMMIT }))).toEqual({ repository: "https://github.com/microsoft/SkillOpt", commit: COMMIT });
  });

  test("a pin that isn't a full commit is refused: a branch or a tag would move under the trainer", () => {
    for (const commit of ["main", "v0.2.0", COMMIT.slice(0, 12), `${COMMIT}0`]) {
      expect(() => parsePin(JSON.stringify({ repository: "https://github.com/microsoft/SkillOpt", commit }))).toThrow("isn't a full commit");
    }
  });

  test("a pin without a repository is refused", () => {
    expect(() => parsePin(JSON.stringify({ commit: COMMIT }))).toThrow("repository");
  });

  test("the pin in the repo is a valid one", () => {
    expect(parsePin(readFileSync(PIN_PATH, "utf8")).commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("skilloptArgv", () => {
  test("uv runs python with SkillOpt at the pinned commit and the adapter from the repo, nothing installed globally", () => {
    const pin = { repository: "https://github.com/microsoft/SkillOpt", commit: COMMIT };
    expect(skilloptArgv(pin, ["-m", "mercury_skillopt", "smoke"])).toEqual([
      "uv",
      "run",
      "--quiet",
      "--no-project",
      "--python",
      "3.12",
      "--with",
      `git+https://github.com/microsoft/SkillOpt@${COMMIT}`,
      "--with-editable",
      PYTHON_DIR,
      "python",
      "-m",
      "mercury_skillopt",
      "smoke",
    ]);
  });

  test("the adapter's folder is the python/ next to the trainer's sources", () => {
    expect(PYTHON_DIR).toBe(join(import.meta.dir, "..", "python"));
  });
});
