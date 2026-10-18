/**
 * Runs a plugin's training tasks and scores them: each task in a fresh
 * conversation on its own vault, the plugin built on a fake CLI answering from
 * the task's fixtures and then the plugin's, with the candidate skill in it.
 * A task's turns are read and checked the way an e2e case's are
 * (`turnFromDump`, `createExpect`): `hard` is 1 when every check passed,
 * `soft` the fraction that did. What opens a conversation is injected; the
 * real one composes Mercury (`mercury-conversation.ts`).
 */
import { createExpect, turnFromDump, type Check, type Run, type Turn } from "@mercury-fw/cli/e2e";
import type { Plugin } from "@mercury-fw/plugin-types";
import type { Fixture, Fixtures, SkillTraining, Split, TrainingTask } from "./contract.ts";
import { createFakeCli } from "./fixtures.ts";
import { withSkill } from "./skill-override.ts";

/** A conversation with Mercury: each turn's `/dump` steps and its final reply. */
export type Conversation = {
  send: (text: string) => Promise<{ steps: unknown[]; text: string }>;
  close: () => Promise<void>;
};

export type HarnessDeps = {
  /** Opens a conversation with Mercury running only `plugin`, on the vault at `vaultPath`. */
  open: (plugin: Plugin, vaultPath: string) => Promise<Conversation>;
  makeVault: () => Promise<string>;
  /** Writes `files` (vault-relative path to content) into the vault at `vaultPath`. */
  seedVault: (vaultPath: string, files: Record<string, string>) => Promise<void>;
  removeVault: (path: string) => Promise<void>;
  /** Milliseconds. */
  now: () => number;
};

/** One turn as the result keeps it: what was sent, then the turn. */
export type SentTurn = { sent: string } & Turn;

export type TaskResult = {
  id: string;
  split: Split;
  taskType: string;
  hard: 0 | 1;
  soft: number;
  checks: Check[];
  turns: SentTurn[];
  /** The commands no fixture answered, each as its argv. */
  unmatched: string[][];
  seconds: number;
  /** Why the task stopped before its checks, when it did. */
  error?: string;
};

/** What a task id may be: it names files (SkillOpt's `predictions/<id>/`). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The tasks to run: those of `split` when given, those named in `ids` in
 * their order when given, every task otherwise. Throws on a task id that's
 * repeated or unsafe as a file name, on a task that can't run (no turns, a
 * first turn needing one before it, a vault note outside the vault), and on an
 * id that isn't there or is named twice. */
export function selectTasks(tasks: TrainingTask[], { split, ids }: { split?: Split; ids?: string[] }): TrainingTask[] {
  const byId = new Map<string, TrainingTask>();
  for (const t of tasks) {
    if (!SAFE_ID.test(t.id)) throw new Error(`the task id "${t.id}" isn't safe as a file name`);
    if (byId.has(t.id)) throw new Error(`two tasks have the id "${t.id}"`);
    if (t.turns.length === 0) throw new Error(`the task "${t.id}" has no turns`);
    if (typeof t.turns[0] !== "string") throw new Error(`the task "${t.id}" starts with a function turn, which needs a turn before it`);
    const outside = Object.keys(t.vault ?? {}).find((p) => p.startsWith("/") || p.split("/").includes(".."));
    if (outside !== undefined) throw new Error(`the task "${t.id}" has a vault note outside the vault: ${outside}`);
    byId.set(t.id, t);
  }
  const inSplit = split === undefined ? tasks : tasks.filter((t) => t.split === split);
  if (ids === undefined) return inSplit;
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated !== undefined) throw new Error(`the task "${repeated}" is named twice`);
  return ids.map((id) => {
    const found = inSplit.find((t) => t.id === id);
    if (!found) throw new Error(split === undefined ? `no task "${id}"` : `no task "${id}" in the ${split} split`);
    return found;
  });
}

/** The fixtures `given` stands for, made anew when it's a function. */
const fixturesOf = (given: Fixtures | undefined): Fixture[] => (typeof given === "function" ? given() : (given ?? []));

/** An error's message. */
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The score of `checks`: a run checking nothing proves nothing. */
function score(checks: Check[]): { hard: 0 | 1; soft: number } {
  if (checks.length === 0) return { hard: 0, soft: 0 };
  const passed = checks.filter((c) => c.ok).length;
  return { hard: passed === checks.length ? 1 : 0, soft: passed / checks.length };
}

/** Runs `task` with the plugin `training` builds, its skill body `candidate` (the plugin's own when undefined). */
async function runTask(training: SkillTraining, task: TrainingTask, candidate: string | undefined, deps: HarnessDeps): Promise<TaskResult> {
  const started = deps.now();
  const cli = createFakeCli([...fixturesOf(task.fixtures), ...fixturesOf(training.fixtures)]);
  const plugin = withSkill(training.plugin(cli.run), training.skill, candidate);
  const turns: SentTurn[] = [];
  let checks: Check[];
  let error: string | undefined;
  const vault = await deps.makeVault();
  try {
    if (task.vault !== undefined) await deps.seedVault(vault, task.vault);
    const conversation = await deps.open(plugin, vault);
    try {
      for (const text of task.turns) {
        const sent = typeof text === "string" ? text : text(turns.at(-1)!);
        const turnStarted = deps.now();
        const reply = await conversation.send(sent);
        const data = turnFromDump(reply.steps);
        const answer = data.calls.length === 0 && data.answer === "" ? reply.text : data.answer;
        turns.push({ sent, calls: data.calls, answer, seconds: (deps.now() - turnStarted) / 1000 });
      }
    } finally {
      await conversation.close();
    }
    const run: Run = { turns, last: turns.at(-1)! };
    const recorder = createExpect(run);
    try {
      task.check(run, recorder.expect);
      checks = recorder.checks();
      if (checks.length === 0) checks = [{ label: "the task made no checks", ok: false }];
    } catch (err) {
      checks = [...recorder.checks(), { label: `check threw: ${messageOf(err)}`, ok: false }];
    }
  } catch (err) {
    error = messageOf(err);
    checks = [{ label: `run failed: ${error}`, ok: false }];
  } finally {
    await deps.removeVault(vault);
  }
  const { hard, soft } = error === undefined ? score(checks) : { hard: 0 as const, soft: 0 };
  return {
    id: task.id,
    split: task.split,
    taskType: task.taskType,
    hard,
    soft,
    checks,
    turns,
    unmatched: cli.unmatched(),
    seconds: (deps.now() - started) / 1000,
    ...(error === undefined ? {} : { error }),
  };
}

/** Runs `tasks` one after the other with the skill body `candidate` (the
 * plugin's own when undefined), handing the results so far to `onResult`
 * after each. A task that fails is scored 0, never stops the batch; a
 * candidate for a skill the plugin lacks stops it before any turn. */
export async function runBatch(
  training: SkillTraining,
  tasks: TrainingTask[],
  candidate: string | undefined,
  deps: HarnessDeps,
  onResult: (soFar: TaskResult[]) => Promise<void> = async () => {},
): Promise<TaskResult[]> {
  withSkill(training.plugin(createFakeCli([]).run), training.skill, candidate);
  const results: TaskResult[] = [];
  for (const task of tasks) {
    results.push(await runTask(training, task, candidate, deps));
    await onResult([...results]);
  }
  return results;
}
