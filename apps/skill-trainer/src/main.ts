/**
 * What the commands do, with the real pieces: the plugin's training data from
 * the repo, conversations with a composed Mercury, a throwaway vault per task.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch, selectTasks, type HarnessDeps } from "./harness.ts";
import { loadTraining } from "./load.ts";
import { openMercuryConversation } from "./mercury-conversation.ts";
import type { RunOptions } from "./program.ts";
import { exitCodeFor, formatReport } from "./report.ts";

/** The harness's real dependencies. */
const realDeps: HarnessDeps = {
  open: openMercuryConversation,
  makeVault: () => mkdtemp(join(tmpdir(), "skill-trainer-vault-")),
  removeVault: (path) => rm(path, { recursive: true, force: true }),
  now: () => Date.now(),
};

/** `skill-trainer run`: the tasks once, the report printed, the results
 * written as JSON when asked; exits 1 when a task couldn't run. */
export async function runCommand(opts: RunOptions, print: (line: string) => void = console.log): Promise<number> {
  const training = await loadTraining(opts.plugin);
  const tasks = selectTasks(training.tasks, {
    ...(opts.split === undefined ? {} : { split: opts.split }),
    ...(opts.ids === undefined ? {} : { ids: opts.ids }),
  });
  const candidate = opts.skill === undefined ? undefined : await Bun.file(opts.skill).text();
  const results = await runBatch(training, tasks, candidate, realDeps);
  if (opts.json !== undefined) await writeFile(opts.json, `${JSON.stringify(results, null, 2)}\n`);
  for (const line of formatReport(results)) print(line);
  return exitCodeFor(results);
}
