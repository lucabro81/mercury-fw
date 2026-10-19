#!/usr/bin/env bun
/**
 * The `skill-trainer` executable. It runs with a throwaway home: composing
 * Mercury links the plugins' CLI logins into the home folder, and a training
 * run must never touch the real one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTraining } from "./load.ts";
import { compareCommand, runCommand } from "./main.ts";
import { runProgram } from "./program.ts";
import { realTrainDeps, trainCommand } from "./train.ts";
import { updateSkillOptCommand } from "./update-skillopt.ts";

const home = mkdtempSync(join(tmpdir(), "skill-trainer-home-"));
process.env.HOME = home;
try {
  process.exitCode = await runProgram(process.argv.slice(2), {
    run: (opts) => runCommand(opts),
    compare: (opts) => compareCommand(opts),
    train: (opts) => trainCommand(opts, realTrainDeps((plugin) => loadTraining(plugin))),
    updateSkillOpt: (opts) => updateSkillOptCommand(opts),
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}
