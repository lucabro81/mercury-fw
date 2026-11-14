/**
 * The `expect` a case's `check` receives: helpers that record named checks
 * against a run, passed or failed with a detail, and never throw.
 */
import type { Call } from "./dump.ts";
import type { Expect, Run, Turn } from "./define.ts";

/** One check's outcome; `detail` says what was found when it failed. */
export type Check = { label: string; ok: boolean; detail?: string };

/** A call, one line, for a failure's detail. */
const describe = (c: Call) => `${c.tool} ${JSON.stringify(c.input)}`;

/** `pattern`, as a label says it. */
const said = (pattern: string | RegExp) => (typeof pattern === "string" ? `contains "${pattern}"` : `matches ${pattern}`);
const saidNot = (pattern: string | RegExp) => (typeof pattern === "string" ? `doesn't contain "${pattern}"` : `doesn't match ${pattern}`);
const found = (text: string, pattern: string | RegExp) => (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text));

/** What a turn gave instead of the expected output, or the error instead of it, for a failure's detail. */
function gave(turn: Turn): string {
  if (turn.output !== undefined) return `${turn.output.mode} ${JSON.stringify(turn.output.value)}`;
  const e = turn.outputError;
  if (e !== undefined) return `${e.code} after ${e.attempts} attempts${e.lastError === undefined ? "" : `: ${e.lastError}`}`;
  return `no output: ${turn.answer}`;
}

/** The checks' bounds, as a label says them. */
function boundsLabel({ min, max }: { min?: number; max?: number }, what: string): string {
  if (min !== undefined && max !== undefined) return `${min} to ${max} ${what}`;
  if (max !== undefined) return `at most ${max} ${what}`;
  return `at least ${min ?? 0} ${what}`;
}

/** An `expect` bound to `run`, and the checks it recorded so far. */
export function createExpect(run: Run): { expect: Expect; checks: () => Check[] } {
  const checks: Check[] = [];
  const record = (label: string, ok: boolean, detail?: string) =>
    void checks.push(ok || detail === undefined ? { label, ok } : { label, ok, detail });
  const calls = run.turns.flatMap((t) => t.calls);
  const of = (tool: string) => calls.filter((c) => c.tool === tool);

  const expect: Expect = {
    call: (tool, match, label) => {
      const ok = of(tool).some((c) => match?.(c) ?? true);
      record(label ?? `a ${tool} call`, ok, `calls: ${calls.map((c) => c.tool).join(", ") || "none"}`);
    },
    everyCall: (tool, match, label) => {
      const mine = of(tool);
      const bad = mine.find((c) => !match(c));
      record(label ?? `every ${tool} call matches`, mine.length > 0 && bad === undefined, bad ? describe(bad) : `no ${tool} call`);
    },
    noFailedCalls: (label) => {
      const failed = calls.filter((c) => !c.ok);
      record(label ?? "no failed calls", failed.length === 0, failed.map(describe).join("; "));
    },
    callCount: (bounds, tool, label) => {
      const n = (tool === undefined ? calls : of(tool)).length;
      const ok = n >= (bounds.min ?? 0) && n <= (bounds.max ?? Infinity);
      const what = tool === undefined ? "calls" : `${tool} call${bounds.max === 1 || bounds.min === 1 ? "" : "s"}`;
      record(label ?? boundsLabel(bounds, what), ok, String(n));
    },
    answer: (pattern, label) => record(label ?? `answer ${said(pattern)}`, found(run.last.answer, pattern), run.last.answer),
    answerNot: (pattern, label) => record(label ?? `answer ${saidNot(pattern)}`, !found(run.last.answer, pattern), run.last.answer),
    output: (match, label) => {
      const out = run.last.output;
      record(label ?? (match === undefined ? "an output" : "an output that matches"), out !== undefined && (match?.(out.value) ?? true), gave(run.last));
    },
    outputError: (code, label) => {
      const e = run.last.outputError;
      record(label ?? `a TurnOutputError${code === undefined ? "" : ` ${code}`}`, e !== undefined && (code === undefined || e.code === code), gave(run.last));
    },
    that: (label, condition) => record(label, condition),
  };
  return { expect, checks: () => [...checks] };
}
