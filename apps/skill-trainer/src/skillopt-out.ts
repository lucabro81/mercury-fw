/**
 * What SkillOpt reads of a run, written by `run --skillopt-out` for the Python
 * adapter (`python/mercury_skillopt`) to hand over as is: per task, the
 * conversation its analyst reflects on (`predictions/<id>/conversation.json`,
 * in the entry shapes SkillOpt's reflection renders) and the rollout result
 * (`results.json`); and, for `train`, the tasks as SkillOpt's split items.
 * The adapter holds no logic, so all of it is here, under `bun test`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Split, TrainingTask } from "./contract.ts";
import type { TaskResult } from "./harness.ts";

/** How much of a tool's output the analyst sees. */
const MAX_OBS = 4000;

/** `text` cut to `MAX_OBS` characters, saying how many were left out. */
function cut(text: string): string {
  return text.length <= MAX_OBS ? text : `${text.slice(0, MAX_OBS)}… [${text.length - MAX_OBS} more characters]`;
}

type Entry = { role: "user" | "assistant" | "system"; content: string } | { type: "tool_call"; cmd: string; obs: string };

/** A result as the conversation SkillOpt's analyst reads: every turn's message,
 * calls and answer, then what the checks said (or why the task couldn't run). */
export function conversationOf(result: TaskResult): Entry[] {
  const entries: Entry[] = [];
  for (const turn of result.turns) {
    entries.push({ role: "user", content: turn.sent });
    for (const call of turn.calls) entries.push({ type: "tool_call", cmd: `${call.tool} ${JSON.stringify(call.input)}`, obs: cut(JSON.stringify(call.output) ?? "") });
    entries.push({ role: "assistant", content: turn.answer });
  }
  if (result.error !== undefined) {
    entries.push({ role: "system", content: `the task couldn't run: ${result.error}` });
    return entries;
  }
  const lines = result.checks.map((c) => `[${c.ok ? "pass" : "FAIL"}] ${c.label}${!c.ok && c.detail ? ` (${c.detail})` : ""}`);
  if (result.unmatched.length > 0) lines.push(`commands the fake service didn't know: ${result.unmatched.map((argv) => argv.join(" ")).join("; ")}`);
  entries.push({ role: "system", content: `checks:\n${lines.join("\n")}` });
  return entries;
}

/** A rollout result as SkillOpt's trainer and analyst read it. */
export type Rollout = {
  id: string;
  hard: 0 | 1;
  soft: number;
  task_type: string;
  task_description: string;
  fail_reason: string;
  predicted_answer: string;
  n_turns: number;
  /** Why the task couldn't run, when it couldn't: the adapter stops a training on a batch where every result has one. */
  error?: string;
};

/** What SkillOpt reads of `result`. */
export function rolloutOf(result: TaskResult): Rollout {
  return {
    id: result.id,
    hard: result.hard,
    soft: result.soft,
    task_type: result.taskType,
    task_description: result.turns.map((t, i) => `turn ${i + 1}: ${t.sent}`).join("\n"),
    fail_reason: result.error ?? result.checks.filter((c) => !c.ok).map((c) => c.label).join("; "),
    predicted_answer: result.turns.at(-1)?.answer ?? "",
    n_turns: result.turns.length,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/** Writes `results` under `dir` the way the adapter hands them to SkillOpt. */
export async function writeSkillOptRollout(dir: string, results: TaskResult[]): Promise<void> {
  for (const result of results) {
    const taskDir = join(dir, "predictions", result.id);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "conversation.json"), `${JSON.stringify(conversationOf(result), null, 2)}\n`);
  }
  await writeFile(join(dir, "results.json"), `${JSON.stringify(results.map(rolloutOf), null, 2)}\n`);
}

/** A task as one of SkillOpt's split items: its first turn, always text (selectTasks refuses a function first), stands for the request. */
export type SkillOptItem = { id: string; task_type: string; question: string };

/** `tasks` as SkillOpt's split items, by split. */
export function skillOptItems(tasks: TrainingTask[]): Record<Split, SkillOptItem[]> {
  const items: Record<Split, SkillOptItem[]> = { train: [], val: [], test: [] };
  for (const t of tasks) items[t.split].push({ id: t.id, task_type: t.taskType, question: t.turns[0] as string });
  return items;
}
