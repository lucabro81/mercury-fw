/**
 * What a plugin gives the skill trainer: the default export of the
 * `skill-training/index.ts` next to its code. The skill to train, the plugin
 * built on the CLI runner the trainer hands in, the fixtures that runner
 * answers from, and the tasks a skill is scored on. A task's turns and checks
 * are an e2e case's (`@mercury-fw/cli/e2e`), so one is written the same way.
 */
import type { Expect, Run, TurnText } from "@mercury-fw/cli/e2e";
import type { runCli } from "@mercury-fw/cli-engine";
import type { CliResult, Plugin } from "@mercury-fw/plugin-types";

/** The CLI runner a plugin is built on. */
export type RunCli = typeof runCli;

/**
 * One answer of the fake CLI: the command it answers and what it prints.
 * The model writes the same command many ways (flag order, quoting), so a
 * fixture matches on the parsed argv, not on the line.
 */
export type Fixture = {
  /** The leading arguments, the subcommand: `["issue", "search"]`. */
  command: string[];
  /** Conditions on the positional arguments after the command, in order. */
  args?: Array<string | RegExp>;
  /** Conditions on flags: `true` present, `false` absent, a string the exact
   * value, a pattern the value matching. */
  flags?: Record<string, string | RegExp | boolean>;
  /** Flags that take no value, so the token after one stays a positional
   * (without this, `--unassign KAN-4` reads KAN-4 as the flag's value). */
  switches?: string[];
  /** What the CLI answers. */
  result: CliResult;
};

/** The splits SkillOpt trains, gates and tests on. */
export type Split = "train" | "val" | "test";

/** One task: the turns sent in a fresh session, and the checks on them. */
export type TrainingTask = {
  /** Unique within the plugin, safe as a file name. */
  id: string;
  split: Split;
  /** What SkillOpt samples by: tasks of the same kind share one. */
  taskType: string;
  turns: TurnText[];
  /** Fixtures for this task only, tried before the plugin's own. */
  fixtures?: Fixture[];
  check: (run: Run, expect: Expect) => void;
};

/** What `skill-training/index.ts` exports by default. */
export type SkillTraining = {
  /** The name of the skill to train, one of the plugin's `skills`. */
  skill: string;
  /** The plugin built on `runCliFn`. */
  plugin: (runCliFn: RunCli) => Plugin;
  fixtures: Fixture[];
  tasks: TrainingTask[];
};

/** Types a plugin's `skill-training/index.ts` default export. */
export function defineSkillTraining(training: SkillTraining): SkillTraining {
  return training;
}
