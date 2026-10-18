/**
 * The fake CLI a plugin is built on while its skill is trained: answers each
 * command from the first fixture that matches its argv, and fails any other
 * the way a CLI fails a command it doesn't know, recording it. A run full of
 * unmatched commands is a hole in the fixtures, not a weak skill, and the
 * report says which.
 */
import { basename } from "node:path";
import type { CliResult } from "@mercury-fw/plugin-types";
import type { Fixture, FixtureCall, RunCli } from "./contract.ts";

/** The exit code of an unknown command, as CLIs built on clap use it. */
const USAGE_EXIT_CODE = 2;

/** An argv split into positionals and flags (`--name` or `-n`); a flag without a value is `true`. */
type ParsedArgs = { positionals: string[]; flags: Map<string, string | true> };

/** Whether `token` is a flag: `--name`, or a short `-n`. */
const isFlag = (token: string) => token.startsWith("--") || /^-[A-Za-z]/.test(token);

/** Splits `args` (already tokenized: a quoted value is one token) after the
 * command's own `commandLength` tokens. A token after a flag is its value
 * unless it's a flag itself or the flag is one of `switches`. */
function parse(args: string[], commandLength: number, switches: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const rest = args.slice(commandLength);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!isFlag(token)) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !isFlag(next) && !switches.includes(token)) {
      flags.set(token, next);
      i++;
    } else {
      flags.set(token, true);
    }
  }
  return { positionals, flags };
}

/** Whether `value` meets `condition`: equal to a string, matching a pattern. */
function meets(value: string | undefined, condition: string | RegExp): boolean {
  if (value === undefined) return false;
  if (typeof condition === "string") return value === condition;
  // A g or y pattern keeps where it last matched: start over every time.
  condition.lastIndex = 0;
  return condition.test(value);
}

/** `args` as `fixture` sees it when the fixture answers them, undefined otherwise. */
function match(fixture: Fixture, args: string[]): FixtureCall | undefined {
  if (args.length < fixture.command.length) return undefined;
  if (fixture.command.some((token, i) => args[i] !== token)) return undefined;
  const { positionals, flags } = parse(args, fixture.command.length, fixture.switches ?? []);
  const positionalsOk = (fixture.args ?? []).every((condition, i) => meets(positionals[i], condition));
  const flagsOk = Object.entries(fixture.flags ?? {}).every(([name, condition]) => {
    const value = flags.get(name);
    if (condition === true) return value !== undefined;
    if (condition === false) return value === undefined;
    return meets(typeof value === "string" ? value : undefined, condition);
  });
  return positionalsOk && flagsOk ? { args: [...args], positionals, flags: Object.fromEntries(flags) } : undefined;
}

/** A fake CLI answering from `fixtures`, first match first, and the commands
 * none of them answered so far. */
export function createFakeCli(fixtures: Fixture[]): { run: RunCli; unmatched: () => string[][] } {
  const unmatched: string[][] = [];
  const run: RunCli = async (binary, args): Promise<CliResult> => {
    for (const fixture of fixtures) {
      const call = match(fixture, args);
      if (call === undefined) continue;
      // A copy, as the real CLI parses a fresh one: what a post-processor
      // does to it mustn't reach the next task sharing the fixture.
      return structuredClone(typeof fixture.result === "function" ? fixture.result(call) : fixture.result);
    }
    unmatched.push([...args]);
    return {
      ok: false,
      error: `${basename(binary)} exited with code ${USAGE_EXIT_CODE}: error: unrecognized command or arguments`,
      exitCode: USAGE_EXIT_CODE,
    };
  };
  return { run, unmatched: () => unmatched.map((args) => [...args]) };
}
