/**
 * The `skill-trainer` command line, declared with commander: parsing and
 * validation happen here, before anything runs; what a command does is the
 * handler passed in (`main.ts`).
 */
import { Command, CommanderError, Option, type OutputConfiguration } from "commander";
import type { Split } from "./contract.ts";

/** What `run` was asked for. */
export type RunOptions = {
  plugin: string;
  /** A candidate skill's file: its body, or a whole `SKILL.md`. */
  skill?: string;
  split?: Split;
  ids?: string[];
  /** A file to write the results to as JSON (what the SkillOpt adapter reads),
   * besides the report: not stdout, where the core logs too. */
  json?: string;
};

export type ProgramHandlers = {
  /** `skill-trainer run`; returns the exit code. */
  run: (opts: RunOptions) => Promise<number>;
};

/** The command line, bound to `handlers`; a command's exit code lands in `result`. */
function buildProgram(handlers: ProgramHandlers, result: { code: number }): Command {
  const program = new Command("skill-trainer").description(
    "Scores a plugin's skill: its training tasks run as real Mercury turns on the configured model, its CLI answered by fixtures.",
  );

  program
    .command("run")
    .description("Runs a plugin's training tasks once with a skill (the plugin's own by default) and prints every check and every command no fixture answered.")
    .argument("<plugin>", "the plugin, by the name of its folder after plugin- (jira for packages/tools/plugin-jira)")
    .option("--skill <file>", "a candidate skill: its body, or a whole SKILL.md with the skill's own name and description")
    .addOption(new Option("--split <split>", "only the tasks of this split").choices(["train", "val", "test"]))
    .option("--task <ids...>", "only these tasks, in this order")
    .option("--json <file>", "also write the results to this file as JSON")
    .addHelpText("after", "\nExamples:\n  skill-trainer run jira\n  skill-trainer run jira --skill out/best_skill.md --split test")
    .action(async (plugin: string, opts: { skill?: string; split?: Split; task?: string[]; json?: string }) => {
      result.code = await handlers.run({
        plugin,
        ...(opts.skill === undefined ? {} : { skill: opts.skill }),
        ...(opts.split === undefined ? {} : { split: opts.split }),
        ...(opts.task === undefined ? {} : { ids: opts.task }),
        ...(opts.json === undefined ? {} : { json: opts.json }),
      });
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
