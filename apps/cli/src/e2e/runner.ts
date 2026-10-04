/**
 * Runs e2e tests against an app: for each case (as many times as it
 * repeats), a fresh session (the REPL, or one conversation on the HTTP
 * surface) gets the case's turns, the checks run on what each turn did, and
 * every check is printed; the exit code says whether every case passed enough
 * runs. The sessions, the container commands and the report's destination are
 * injected (`session.ts`, `http-session.ts` and `commands.ts` hold the real
 * ones), so the tests drive the runner with scripted turns.
 */
import { CATALOG } from "../catalog.ts";
import type { Context, E2eCase, E2eTest, Run, Turn } from "./define.ts";
import { turnFromDump, type TurnData } from "./dump.ts";
import { createExpect, type Check } from "./expect.ts";

/** What a REPL turn gives back: what `/dump` wrote for it and what the REPL printed meanwhile. */
export type ReplReply = { dump: unknown; output: string };
/** What an HTTP turn gives back: the turn read off its stream, and the response's status. */
export type HttpReply = { turn: TurnData; status: number };

/** A session in the app: `turn` sends one turn (on HTTP with the user's
 * token) and resolves with what came back. */
export type Session<Reply extends ReplReply | HttpReply = ReplReply | HttpReply> = {
  turn: (line: string, token?: string) => Promise<Reply>;
  close: () => Promise<void>;
};

/** Where a case's turns go. */
export type Channel = "repl" | "http";

export type RunnerDeps = {
  openSession: (channel: Channel) => Promise<Session>;
  cli: Context["cli"];
  /** The app's dependencies, to check the test's plugins and channels against. */
  appPackages: Record<string, string>;
  print: (line: string) => void;
  /** Milliseconds, for each turn's duration. */
  now: () => number;
  writeReport: (report: CaseReport[]) => Promise<void>;
};

/** One run of a case, as the report keeps it. */
export type RunReport = { ok: boolean; turns: Turn[]; checks: Check[] };
export type CaseReport = { file: string; case: string; passed: boolean; runs: RunReport[] };

/** The prompt the REPL prints after a reply, with its context-usage suffix. */
const PROMPT = /(\[[^\]\n]*\] )?> $/;

/** A turn's printed output as an answer: no styling, no trailing prompt. */
function answerFromOutput(output: string): string {
  return output.replace(/\u001b\[[0-9;]*m/g, "").replace(PROMPT, "").trim();
}

/** The test's plugins and channels the app doesn't depend on, as a message, or undefined. */
function missing(test: E2eTest, packages: Record<string, string>): string | undefined {
  // A case on the HTTP surface needs the channel, listed or not.
  const channels = new Set([...(test.channels ?? []), ...(test.cases.some((c) => c.channel === "http") ? ["http"] : [])]);
  const wanted = [
    ...(test.plugins ?? []).map((id) => ({ id, kind: "tool" as const, word: "plugin" })),
    ...[...channels].map((id) => ({ id, kind: "channel" as const, word: "channel" })),
  ];
  const lacking = wanted.flatMap(({ id, kind, word }) => {
    const pkg = CATALOG.find((e) => e.kind === kind && e.id === id)?.package;
    if (pkg === undefined) return [`${word} ${id} (not in the catalog)`];
    return packages[pkg] === undefined ? [`${word} ${id} (${pkg})`] : [];
  });
  return lacking.length > 0 ? `the app lacks what the test needs: ${lacking.join(", ")}` : undefined;
}

/** Runs the tests in `tests` (each with the file it came from); returns the
 * exit code: 0 when every case passed enough runs. `repeat` overrides each
 * case's own. */
export async function runE2e(
  tests: Array<{ file: string; test: E2eTest }>,
  opts: { repeat?: number },
  deps: RunnerDeps,
): Promise<number> {
  const report: CaseReport[] = [];
  let code = 0;
  for (const { file, test } of tests) {
    deps.print(file);
    const lacking = missing(test, deps.appPackages);
    if (lacking !== undefined) {
      deps.print(`  ${lacking}`);
      code = 1;
      continue;
    }
    for (const c of test.cases) {
      const result = await runCase(c, test.users ?? {}, opts.repeat, deps);
      report.push({ file, case: c.name, ...result });
      if (!result.passed) code = 1;
    }
  }
  await deps.writeReport(report);
  return code;
}

/** Runs one case as many times as it repeats, printing each run's checks and the verdict. */
async function runCase(
  c: E2eCase,
  users: Record<string, string>,
  repeatOverride: number | undefined,
  deps: RunnerDeps,
): Promise<{ passed: boolean; runs: RunReport[] }> {
  const repeat = repeatOverride ?? c.repeat ?? 1;
  const minPasses = Math.min(c.minPasses ?? repeat, repeat);
  deps.print(`  ${c.name}`);
  const runs: RunReport[] = [];
  for (let i = 1; i <= repeat; i++) {
    if (repeat > 1) deps.print(`    run ${i}/${repeat}`);
    const run = await runOnce(c, users, deps);
    const indent = repeat > 1 ? "      " : "    ";
    for (const check of run.checks) {
      deps.print(`${indent}${check.ok ? "✓" : "✗"} ${check.label}${check.ok || check.detail === undefined ? "" : `: ${check.detail}`}`);
    }
    runs.push(run);
  }
  const passes = runs.filter((r) => r.ok).length;
  const passed = passes >= minPasses;
  deps.print(
    repeat > 1
      ? `  ${c.name}: ${passes}/${repeat} runs passed (needs ${minPasses})${passed ? "" : " FAILED"}`
      : `  ${c.name}: ${passed ? "passed" : "FAILED"}`,
  );
  return { passed, runs };
}

/** The token a turn is sent with: none on the REPL, its user's (the turn's
 * own, or the case's) on HTTP; throws when that doesn't add up. */
function tokenFor(channel: Channel, user: string | undefined, users: Record<string, string>): string | undefined {
  if (channel === "repl") {
    if (user !== undefined) throw new Error('"as" goes with channel "http"');
    return undefined;
  }
  if (user === undefined) throw new Error('an HTTP turn needs a user: "as" on the case or on the turn');
  const token = users[user];
  if (token === undefined) throw new Error(`unknown user "${user}" (the test's users: ${Object.keys(users).join(", ") || "none"})`);
  return token;
}

/** One run of a case in a fresh session: `before`, the turns, the checks, `after`. */
async function runOnce(c: E2eCase, users: Record<string, string>, deps: RunnerDeps): Promise<RunReport> {
  const channel: Channel = c.channel ?? "repl";
  const ctx: Context = { cli: deps.cli };
  const turns: Turn[] = [];
  let checks: Check[] = [];
  try {
    await c.before?.(ctx);
    // Every turn's user is settled before the session opens, so a case that
    // doesn't add up costs nothing.
    const planned = c.turns.map((next) => {
      const { text, as } = typeof next === "object" ? next : { text: next, as: undefined };
      return { text, token: tokenFor(channel, as ?? c.as, users) };
    });
    const session = await deps.openSession(channel);
    try {
      for (const { text, token } of planned) {
        const line = typeof text === "string" ? text : text(turns.at(-1)!);
        if (channel === "repl" && line.includes("\n")) throw new Error("a turn must be one line (the REPL reads one line per turn)");
        const start = deps.now();
        const reply = await session.turn(line, token);
        const seconds = (deps.now() - start) / 1000;
        if ("status" in reply) {
          turns.push({ ...reply.turn, seconds, status: reply.status });
          continue;
        }
        const data = turnFromDump(reply.dump);
        const answer = data.calls.length === 0 && data.answer === "" ? answerFromOutput(reply.output) : data.answer;
        turns.push({ calls: data.calls, answer, seconds });
      }
    } finally {
      await session.close();
    }
    const run: Run = { turns, last: turns.at(-1)! };
    const recorder = createExpect(run);
    try {
      await c.check(run, recorder.expect, ctx);
      checks = recorder.checks();
      // A case that checks nothing proves nothing.
      if (checks.length === 0) checks = [{ label: "the case made no checks", ok: false }];
    } catch (err) {
      checks = [...recorder.checks(), { label: `check threw: ${err instanceof Error ? err.message : String(err)}`, ok: false }];
    }
  } catch (err) {
    checks = [{ label: `run failed: ${err instanceof Error ? err.message : String(err)}`, ok: false }];
  } finally {
    try {
      await c.after?.(ctx);
    } catch (err) {
      checks = [...checks, { label: `after threw: ${err instanceof Error ? err.message : String(err)}`, ok: false }];
    }
  }
  return { ok: checks.every((ch) => ch.ok), turns, checks };
}
