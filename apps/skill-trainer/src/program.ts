/**
 * The `skill-trainer` command line, declared with commander: parsing and
 * validation happen here, before anything runs; what a command does is the
 * handler passed in (`main.ts`).
 */
import { Command, CommanderError, InvalidArgumentError, Option, type OutputConfiguration } from "commander";
import type { Split } from "./contract.ts";
import type { TrainOptions } from "./train.ts";
import type { UpdateOptions } from "./update-skillopt.ts";

/** What `run` was asked for. */
export type RunOptions = {
  plugin: string;
  /** A candidate skill's file: its body, or a whole `SKILL.md`. */
  skill?: string;
  split?: Split;
  ids?: string[];
  /** A file to write the results to as JSON, for comparing runs,
   * besides the report: not stdout, where the core logs too. */
  json?: string;
  /** How many times every task runs; once when absent. */
  repeat?: number;
  /** A folder to write what SkillOpt reads of the run into (the adapter's rollout). */
  skilloptOut?: string;
};

/** A whole number of at least 1, for `--repeat`. */
function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError("a whole number of at least 1");
  return Number(value);
}

/** What `compare` was asked for: two `run --json` files. */
export type CompareOptions = { baseline: string; candidate: string };

export type ProgramHandlers = {
  /** `skill-trainer run`; returns the exit code. */
  run: (opts: RunOptions) => Promise<number>;
  /** `skill-trainer compare`; returns the exit code. */
  compare: (opts: CompareOptions) => Promise<number>;
  /** `skill-trainer train`; returns the exit code. */
  train: (opts: TrainOptions) => Promise<number>;
  /** `skill-trainer update-skillopt`; returns the exit code. */
  updateSkillOpt: (opts: UpdateOptions) => Promise<number>;
};

/** The command line, bound to `handlers`; a command's exit code lands in `result`. */
function buildProgram(handlers: ProgramHandlers, result: { code: number }): Command {
  const program = new Command("skill-trainer").description(
    "Scores and trains a plugin's skill: its training tasks run as real Mercury turns on the configured model, its CLI answered by fixtures.",
  );

  program
    .command("run")
    .description("Runs a plugin's training tasks with a skill (the plugin's own by default), once or --repeat times, and prints every check and every command no fixture answered.")
    .argument("<plugin>", "the plugin, by the name of its folder after plugin- (jira for packages/tools/plugin-jira)")
    .option("--skill <file>", "a candidate skill: its body, or a whole SKILL.md with the skill's own name and description")
    .addOption(new Option("--split <split>", "only the tasks of this split").choices(["train", "val", "test"]))
    .option("--task <ids...>", "only these tasks, in this order")
    .option("--json <file>", "also write the results to this file as JSON, with the run's conditions (commit, model, skill and data hashes)")
    .option("--repeat <n>", "run every task n times", positiveInteger)
    .addOption(new Option("--skillopt-out <dir>", "also write what SkillOpt reads of the run into this folder (used by train)").conflicts("repeat"))
    .addHelpText("after", "\nExamples:\n  skill-trainer run jira\n  skill-trainer run jira --skill out/SKILL.md --split test --repeat 3 --json results/candidate.json")
    .action(async (plugin: string, opts: { skill?: string; split?: Split; task?: string[]; json?: string; repeat?: number; skilloptOut?: string }) => {
      result.code = await handlers.run({
        plugin,
        ...(opts.skill === undefined ? {} : { skill: opts.skill }),
        ...(opts.split === undefined ? {} : { split: opts.split }),
        ...(opts.task === undefined ? {} : { ids: opts.task }),
        ...(opts.json === undefined ? {} : { json: opts.json }),
        ...(opts.repeat === undefined ? {} : { repeat: opts.repeat }),
        ...(opts.skilloptOut === undefined ? {} : { skilloptOut: opts.skilloptOut }),
      });
    });

  program
    .command("compare")
    .description(
      "Whether a candidate skill does better than a baseline, from two runs' --json files made under the same conditions: the mean per-task gain, its 95% bounds from a bootstrap over tasks, the gain per task type and every task that got worse.",
    )
    .argument("<baseline>", "the results of the baseline skill (run --json)")
    .argument("<candidate>", "the results of the candidate skill (run --json)")
    .addHelpText("after", "\nExample:\n  skill-trainer compare results/baseline.json results/candidate.json")
    .action(async (baseline: string, candidate: string) => {
      result.code = await handlers.compare({ baseline, candidate });
    });

  program
    .command("train")
    .description(
      "Trains a plugin's skill with SkillOpt (run with uv, pinned in skillopt.json): its rollouts are this trainer's runs, its optimizer the model in OLLAMA_HOST/OLLAMA_MODEL unless --config sets another. Writes the trained SKILL.md into the output folder, never into the plugin.",
    )
    .argument("<plugin>", "the plugin, by the name of its folder after plugin-")
    .option("--config <file>", "SkillOpt settings over skillopt-defaults.yaml (epochs, batch size, gate, the optimizer model and its endpoint or API key)")
    .option("--out <dir>", "a new or empty output folder (default: results/train-<plugin>-<time>)")
    .addHelpText("after", "\nExamples:\n  skill-trainer train jira\n  skill-trainer train jira --config my-training.yaml --out results/jira-try-1")
    .action(async (plugin: string, opts: { config?: string; out?: string }) => {
      result.code = await handlers.train({
        plugin,
        ...(opts.config === undefined ? {} : { config: opts.config }),
        ...(opts.out === undefined ? {} : { out: opts.out }),
      });
    });

  program
    .command("update-skillopt")
    .description(
      "Moves the SkillOpt pin (skillopt.json) to a new commit, after the adapter's smoke check and its tests pass on it; a commit that fails either leaves the pin where it was.",
    )
    .option("--ref <ref>", "a branch, a tag or a full commit of SkillOpt's repository", "main")
    .addHelpText("after", "\nExamples:\n  skill-trainer update-skillopt\n  skill-trainer update-skillopt --ref v0.3.0")
    .action(async (opts: { ref: string }) => {
      result.code = await handlers.updateSkillOpt(opts.ref === "main" ? {} : { ref: opts.ref });
    });

  return program;
}

/** Runs `skill-trainer` on `argv` (the arguments after the command name) and
 * returns the exit code. Commander's own messages go to `output`, and so does
 * the message of an error a command throws. */
export async function runProgram(argv: string[], handlers: ProgramHandlers, output?: OutputConfiguration): Promise<number> {
  const result = { code: 0 };
  const program = buildProgram(handlers, result);
  const writeErr = output?.writeErr ?? ((s: string) => process.stderr.write(s));
  const configure = (cmd: Command): void => {
    cmd.exitOverride();
    if (output !== undefined) cmd.configureOutput(output);
    cmd.commands.forEach(configure);
  };
  configure(program);
  if (argv.length === 0) {
    program.outputHelp({ error: true });
    return 1;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return result.code;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
