/**
 * What the commands do. The real pieces (the plugin's training data from the
 * repo, conversations with a composed Mercury, a throwaway vault per task)
 * are the default dependencies; a test hands in its own.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectConditions, type RunConditions } from "./conditions.ts";
import type { SkillTraining } from "./contract.ts";
import { runBatch, selectTasks, type HarnessDeps, type TaskResult } from "./harness.ts";
import { loadTraining, REPO_ROOT, trainingPath } from "./load.ts";
import { openMercuryConversation } from "./mercury-conversation.ts";
import type { RunOptions } from "./program.ts";
import { exitCodeFor, formatReport } from "./report.ts";
import { withSkill } from "./skill-override.ts";

export type CommandDeps = {
  loadTraining: (plugin: string) => Promise<SkillTraining>;
  harness: HarnessDeps;
  /** The conditions of a run of `skillBody` on `plugin`'s training data. */
  conditions: (skillBody: string, plugin: string) => Promise<RunConditions>;
  print: (line: string) => void;
};

/** A task's result in one of the run's repeats (1 to n). */
export type RunResult = TaskResult & { repeat: number };

/** What `--json` writes: the run's conditions (null until they're taken) and its results so far. */
export type RunFile = { conditions: RunConditions | null; results: RunResult[] };

/** git's stdout for `args`, run in the repo; throws when git fails. */
async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out;
}

/** Writes `files` (vault-relative path to content) into the vault at `vault`, folders made as needed. */
export async function seedVaultFiles(vault: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    await writeFile(join(vault, path), content);
  }
}

/** The real dependencies. */
const realDeps: CommandDeps = {
  loadTraining: (plugin) => loadTraining(plugin),
  harness: {
    open: openMercuryConversation,
    makeVault: () => mkdtemp(join(tmpdir(), "skill-trainer-vault-")),
    seedVault: (vault, files) => seedVaultFiles(vault, files),
    removeVault: (path) => rm(path, { recursive: true, force: true }),
    now: () => Date.now(),
  },
  conditions: (skillBody, plugin) => collectConditions(skillBody, dirname(trainingPath(plugin)), { git, env: process.env }),
  print: console.log,
};

/** Writes `file` to `path` as JSON. */
const writeRun = (path: string, file: RunFile) => writeFile(path, `${JSON.stringify(file, null, 2)}\n`);

/** The body of `training`'s skill that a run with `candidate` uses: the candidate's, or the plugin's own. */
function skillBodyOf(training: SkillTraining, candidate: string | undefined): string {
  const plugin = withSkill(training.plugin(async () => ({ ok: false, exitCode: 1, error: "no CLI" })), training.skill, candidate);
  return plugin.skills!.find((s) => s.name === training.skill)!.body;
}

/**
 * `skill-trainer run`: the tasks, `--repeat` times (once by default), and the
 * report printed; exits 1 when a task couldn't run. The run's conditions are
 * taken before any task. The JSON file, when asked for, is emptied first (a
 * path that can't be written stops the run before any task, and no earlier
 * run's results stay in it) and rewritten as each task ends, so a run cut
 * short keeps what it did.
 */
export async function runCommand(opts: RunOptions, deps: CommandDeps = realDeps): Promise<number> {
  const json = opts.json;
  if (json !== undefined) await writeRun(json, { conditions: null, results: [] });
  const training = await deps.loadTraining(opts.plugin);
  const tasks = selectTasks(training.tasks, {
    ...(opts.split === undefined ? {} : { split: opts.split }),
    ...(opts.ids === undefined ? {} : { ids: opts.ids }),
  });
  const candidate = opts.skill === undefined ? undefined : await Bun.file(opts.skill).text();
  const conditions = await deps.conditions(skillBodyOf(training, candidate), opts.plugin);
  const done: RunResult[] = [];
  for (let repeat = 1; repeat <= (opts.repeat ?? 1); repeat++) {
    const progress = json === undefined ? undefined : (soFar: TaskResult[]) => writeRun(json, { conditions, results: [...done, ...soFar.map((r) => ({ ...r, repeat }))] });
    const results = await runBatch(training, tasks, candidate, deps.harness, progress);
    done.push(...results.map((r) => ({ ...r, repeat })));
  }
  if (json !== undefined) await writeRun(json, { conditions, results: done });
  for (const line of formatReport(done)) deps.print(line);
  return exitCodeFor(done);
}
