/**
 * The shape of an e2e test, as a test file imports it
 * (`import { e2e } from "@mercury-fw/cli/e2e"`): the plugins and channels the
 * app must have, and cases of turns sent to the app's real model, each with
 * checks on the calls it made and the answer it gave. A case talks to the
 * app's REPL, or to its HTTP surface as one of the test's users (each a token
 * the app's auth provider knows). `mfw e2e` runs them (`runner.ts`).
 */
import type { Call, TurnData } from "./dump.ts";

export type { Call } from "./dump.ts";

/** One turn as a check sees it: its calls, its answer, how long it took, and
 * on HTTP the response's status (200, or 401 for a token the app refused).
 * On HTTP a call's `input` is the detail line the surface shows (the command,
 * for a CLI tool) and its `output` is there only for a call staged for
 * confirmation (`{ pendingConfirmation, token, summary }`): the stream carries
 * no tool results. */
export type Turn = TurnData & { seconds: number; status?: number };

/** A case's run: every turn in order, and the last one. */
export type Run = { turns: Turn[]; last: Turn };

/** Runs `command` in the app's container (`sh -c`), outside the model:
 * preparing data, reading what a turn changed, cleaning up. */
export type Cli = (command: string) => Promise<{ code: number; output: string }>;

/** What `before`, `after` and `check` can reach besides the run. */
export type Context = { cli: Cli };

/** The checks a case makes. Call helpers look at every turn's calls, answer
 * helpers at the last answer; each records a named check and never throws,
 * so a case reports every failure at once. */
export type Expect = {
  /** At least one call to `tool`, matching `match` when given. */
  call(tool: string, match?: (call: Call) => boolean, label?: string): void;
  /** Every call to `tool` matches `match` (and there is at least one). */
  everyCall(tool: string, match: (call: Call) => boolean, label?: string): void;
  /** No call failed or went without a result. */
  noFailedCalls(label?: string): void;
  /** The number of calls, to every tool or to `tool`, within the bounds. */
  callCount(bounds: { min?: number; max?: number }, tool?: string, label?: string): void;
  /** The answer contains `pattern`, or matches it. */
  answer(pattern: string | RegExp, label?: string): void;
  /** The answer doesn't contain `pattern`, or doesn't match it. */
  answerNot(pattern: string | RegExp, label?: string): void;
  /** Anything else. */
  that(label: string, condition: boolean): void;
};

/** A turn's text: a message, or a function of the turn before (a follow-up, a confirmation token). */
export type TurnText = string | ((previous: Turn) => string);

/** One case: the turns sent, in one session (one REPL, or one HTTP
 * conversation), and the checks on them. */
export type E2eCase = {
  name: string;
  /** Where the turns go: the REPL (the default) or the HTTP surface, which
   * must be running (`mfw start`). */
  channel?: "repl" | "http";
  /** On HTTP, the user (one of the test's `users`) the turns are sent as. */
  as?: string;
  /** The turns; on HTTP one can name its own user, so a case can stage an
   * action as one person and try to confirm it as another, in the same
   * conversation id. */
  turns: Array<TurnText | { text: TurnText; as: string }>;
  /** How many times to run it (the model isn't deterministic); default 1. */
  repeat?: number;
  /** How many runs must pass; default every one. */
  minPasses?: number;
  before?: (ctx: Context) => unknown;
  after?: (ctx: Context) => unknown;
  check: (run: Run, expect: Expect, ctx: Context) => unknown;
};

/** An e2e test: what the app must have, and its cases. */
export type E2eTest = {
  /** The users the HTTP cases send their turns as: a name and the token the
   * app's auth provider accepts for it (a test token, like `static`'s). */
  users?: Record<string, string>;
  /** Catalog ids of the tool plugins the app must have (`jira`, …). */
  plugins?: string[];
  /** Catalog ids of the channels the app must have (`http`, …). */
  channels?: string[];
  cases: E2eCase[];
};

/** Declares an e2e test: the identity, there for the types. */
export function e2e(test: E2eTest): E2eTest {
  return test;
}
