/**
 * What the Jira tasks check, shared by every task file: reading a call (its
 * command line, its tokenized JQL), the checks most tasks make, and the task
 * shapes most of them take. The checks look at the calls, their arguments and
 * the facts the answer has to carry, never at its wording.
 */
import { parseCommand } from "@mercury-fw/cli-engine";
import type { Call, Expect, Run, Split, TrainingTask } from "../../../../apps/skill-trainer/src/contract.ts";

/** A jiraCommand call's command line. */
export const cmd = (c: Call) => String((c.input as { command?: unknown }).command ?? "");
export const calls = (run: Run) => run.turns.flatMap((t) => t.calls);
export const jiraCalls = (run: Run, sub: string) => calls(run).filter((c) => c.tool === "jiraCommand" && cmd(c).includes(sub));

/** A call's JQL, tokenized the way Mercury tokenizes the command (quotes and escapes resolved). */
export function jqlOf(c: Call): string {
  const parsed = parseCommand(cmd(c));
  if (!parsed.ok) return "";
  const at = parsed.args.indexOf("--jql");
  if (at !== -1) return parsed.args[at + 1] ?? "";
  return parsed.args.find((a) => a.startsWith("--jql="))?.slice("--jql=".length) ?? "";
}

/** Small numbers as a model may write them out. */
export const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** The reads the CLI refuses without `--select`. */
export const READS = ["issue search", "issue get", "user search", "project search"];

/** The checks most tasks share. */
export const checks = {
  loadsSkill: (e: Expect) => e.call("read_skill", (c) => (c.input as { name?: string }).name === "jira", "loads the jira skill"),
  /** A search that worked whose JQL matches `pattern`. */
  searched: (e: Expect, pattern: RegExp, label: string) => e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue search") && pattern.test(jqlOf(c)), label),
  /** A search that worked whose command line (its flags beyond the JQL) matches `pattern`. */
  searchedWith: (e: Expect, pattern: RegExp, label: string) => e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue search") && pattern.test(cmd(c)), label),
  /** Every read went out with `--select` (or `--select-all`). */
  selects: (e: Expect, run: Run) =>
    e.that(
      "every read has --select",
      calls(run)
        .filter((c) => c.tool === "jiraCommand" && READS.some((r) => cmd(c).includes(r)) && !/\s(--help|-h)\b/.test(cmd(c)))
        .every((c) => /--select(-all)?\b/.test(cmd(c))),
    ),
  presented: (e: Expect) => e.call("present", (c) => c.ok, "shows the list with present"),
  notPresented: (e: Expect) => e.callCount({ max: 0 }, "present", "doesn't show a list it wasn't asked for"),
  /** The answer has `n` as a number of its own, in figures or (up to twelve) in words. */
  number: (e: Expect, n: number) => e.answer(new RegExp(`(?<![\\w-])(${n}${WORDS[n] ? `|${WORDS[n]}` : ""})(?![\\w-])`, "i"), `the answer says ${n}`),
};

export const task = (id: string, split: Split, taskType: string, turn: string | TrainingTask["turns"], check: (run: Run, e: Expect) => void): TrainingTask => ({
  id,
  split,
  taskType,
  turns: Array.isArray(turn) ? turn : [turn],
  check,
});

/** A list the user wants to see: searched as asked, shown with present. */
export const listTask = (id: string, split: Split, turn: string, jql: RegExp) =>
  task(id, split, "list", turn, (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, jql, "searches the right issues");
    checks.searchedWith(e, /--select[ =]\S*issues\.key/, "selects the list's paths");
    checks.presented(e);
    checks.selects(e, run);
  });

/** A count: searched as asked, answered as a number, no list shown. */
export const countTask = (id: string, split: Split, turn: string, jql: RegExp, n: number) =>
  task(id, split, "count", turn, (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, jql, "searches the right issues");
    checks.number(e, n);
    checks.notPresented(e);
    checks.selects(e, run);
  });

/** One field of one issue: read with issue get (or a search), answered with the fact. */
export const issueTask = (id: string, split: Split, turn: string, key: string, fact: string | RegExp) =>
  task(id, split, "single-issue", turn, (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes(key) && /issue (get|search)/.test(cmd(c)), `reads ${key}`);
    e.answer(fact);
    checks.notPresented(e);
    checks.selects(e, run);
  });

/** A move to `status`: the transition made with the status's name, said done. */
export const transitionTask = (id: string, split: Split, turn: string, key: string, status: string) =>
  task(id, split, "transition", turn, (run, e) => {
    checks.loadsSkill(e);
    const to = new RegExp(`--to[ =]["']?${status}["']?(\\s|$)`, "i");
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue transition ") && cmd(c).includes(key) && to.test(cmd(c)), `moves ${key} to ${status}`);
    e.answer(key, `the answer names ${key}`);
  });

/** An assignment to a person found by name: user search, then assign with their accountId. */
export const assignTask = (id: string, split: Split, turn: string, key: string, accountId: string) =>
  task(id, split, "assign", turn, (run, e) => {
    checks.loadsSkill(e);
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("user search"), "finds the person with user search");
    e.call("jiraCommand", (c) => c.ok && cmd(c).includes("issue assign") && cmd(c).includes(key) && cmd(c).includes(accountId), `assigns ${key} with the person's accountId`);
    checks.selects(e, run);
  });

/** A filter the user words as Jira doesn't: the right status searched in the end (or every issue's
 * status read and the matching ones counted, an equally right way), the issues counted. */
export const wordingTask = (id: string, split: Split, turn: string, status: RegExp, n: number, project: string) =>
  task(id, split, "status-wording", turn, (run, e) => {
    checks.loadsSkill(e);
    const searches = jiraCalls(run, "issue search").filter((c) => c.ok);
    const ofProject = new RegExp(`project\\s*(=|in\\s*\\()\\s*["']?${project}\\b`, "i");
    e.that(
      "searches the status by its Jira name, or reads the statuses",
      searches.some((c) => status.test(jqlOf(c))) ||
        searches.some((c) => ofProject.test(jqlOf(c)) && /--select[ =]\S*issues\.fields\.status\.name/.test(cmd(c))),
    );
    checks.number(e, n);
    checks.selects(e, run);
  });

/** JQL's relative dates: now(), an offset, or a date function. */
export const RELATIVE_DATE = /now\(\)|[-+]?\d+[dwh]\b|(start|end)of(day|week|month)\(/i;

/** A filter on dates: Jira's relative syntax, never a date it computed; the issues it should find
 * named, and the ones it shouldn't (`absent`) left out. */
export const dateTask = (id: string, split: Split, turn: string, keys: string[], absent: string[] = []) =>
  task(id, split, "relative-date", turn, (run, e) => {
    checks.loadsSkill(e);
    checks.searched(e, RELATIVE_DATE, "uses JQL's relative dates");
    e.that("doesn't write a computed date", !jiraCalls(run, "issue search").some((c) => /\d{4}-\d{2}-\d{2}/.test(jqlOf(c))));
    for (const key of keys) e.answer(key);
    for (const key of absent) e.answerNot(new RegExp(`${key}(?!\\d)`), `leaves ${key} out`);
    checks.selects(e, run);
  });
