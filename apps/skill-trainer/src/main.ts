/**
 * What the commands do. The real pieces (the plugin's training data from the
 * repo, conversations with a composed Mercury, a throwaway vault per task)
 * are the default dependencies; a test hands in its own.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillTraining } from "./contract.ts";
import { runBatch, selectTasks, type HarnessDeps, type TaskResult } from "./harness.ts";
import { loadTraining } from "./load.ts";
import { openMercuryConversation } from "./mercury-conversation.ts";
import type { RunOptions } from "./program.ts";
import { exitCodeFor, formatReport } from "./report.ts";

export type CommandDeps = {
  loadTraining: (plugin: string) => Promise<SkillTraining>;
  harness: HarnessDeps;
  print: (line: string) => void;
};

/** The real dependencies. */
const realDeps: CommandDeps = {
  loadTraining: (plugin) => loadTraining(plugin),
  harness: {
    open: openMercuryConversation,
    makeVault: () => mkdtemp(join(tmpdir(), "skill-trainer-vault-")),
    removeVault: (path) => rm(path, { recursive: true, force: true }),
    now: () => Date.now(),
  },
  print: console.log,
};

/** Writes `results` to `path` as JSON. */
const writeResults = (path: string, results: TaskResult[]) => writeFile(path, `${JSON.stringify(results, null, 2)}\n`);

/**
 * `skill-trainer run`: the tasks once and the report printed; exits 1 when a
 * task couldn't run. The JSON file, when asked for, is emptied first (a path
 * that can't be written stops the run before any task, and no earlier run's
 * results stay in it) and rewritten as each task ends, so a run cut short
 * keeps what it did.
 */
export async function runCommand(opts: RunOptions, deps: CommandDeps = realDeps): Promise<number> {
  const json = opts.json;
  if (json !== undefined) await writeResults(json, []);
  const training = await deps.loadTraining(opts.plugin);
  const tasks = selectTasks(training.tasks, {
    ...(opts.split === undefined ? {} : { split: opts.split }),
    ...(opts.ids === undefined ? {} : { ids: opts.ids }),
  });
  const candidate = opts.skill === undefined ? undefined : await Bun.file(opts.skill).text();
  const results = await runBatch(training, tasks, candidate, deps.harness, json === undefined ? undefined : (soFar) => writeResults(json, soFar));
  for (const line of formatReport(results)) deps.print(line);
  return exitCodeFor(results);
}
