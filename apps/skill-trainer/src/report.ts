/**
 * A batch's results as the `run` command prints them: every task with its
 * checks and the commands no fixture answered, then the scores, warned about
 * when the fixtures had holes.
 */
import type { TaskResult } from "./harness.ts";

/** An argv as typed: arguments with spaces quoted. */
const asTyped = (args: string[]) => args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

/** The exit code of a batch: 1 when no task ran or one couldn't run (its 0
 * says nothing about the skill), 0 otherwise, whatever the tasks scored. */
export function exitCodeFor(results: TaskResult[]): number {
  return results.length === 0 || results.some((r) => r.error !== undefined) ? 1 : 0;
}

/** The lines printed for `results`; each task line says its repeat when the run had several. */
export function formatReport(results: Array<TaskResult & { repeat?: number }>): string[] {
  if (results.length === 0) return ["no tasks ran"];
  const repeated = results.some((r) => (r.repeat ?? 1) > 1);
  const lines: string[] = [];
  for (const r of results) {
    const passed = r.checks.filter((c) => c.ok).length;
    lines.push(`${r.id}${repeated ? ` #${r.repeat ?? 1}` : ""} (${r.split}, ${r.taskType}): ${r.hard === 1 ? "passed" : "FAILED"}, ${passed}/${r.checks.length} checks, ${r.seconds.toFixed(1)}s`);
    for (const c of r.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.ok || c.detail === undefined ? "" : `: ${c.detail}`}`);
    for (const args of r.unmatched) lines.push(`  no fixture for: ${asTyped(args)}`);
  }
  const hard = results.filter((r) => r.hard === 1).length;
  const soft = results.reduce((sum, r) => sum + r.soft, 0) / results.length;
  lines.push("", `hard ${hard}/${results.length} ${repeated ? "results" : "tasks"}, soft ${soft.toFixed(2)}`);
  const holes = results.filter((r) => r.unmatched.length > 0).length;
  if (holes > 0) {
    lines.push(`${holes} task${holes === 1 ? "" : "s"} ran commands no fixture answers: add fixtures for them before trusting these scores`);
  }
  return lines;
}
