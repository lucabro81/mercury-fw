/**
 * The generic, cross-CLI model-invocable tool for the experimental
 * command-string execution model: the model writes an entire CLI
 * invocation as one free-text string (see `src/tools/command-parser.ts`
 * for how that string becomes a binary + argv), and this module validates
 * it — first that the binary is one this Mercury instance actually has a
 * config for, then that the argv shape matches that binary's own
 * allowed-prefix allowlist — before ever executing anything.
 *
 * `CliConfig` is built from a maintainer-authored external config file
 * (see `src/tools/cli-config-loader.ts`), not hand-written TypeScript —
 * `allowedPrefixes` is the default-deny prefix-matching data (each entry
 * also declares whether it needs a confirmation step that doesn't exist
 * yet, see `matchCommand` below), and `globalFlags` is declarative data
 * for CLI-specific pre-processing (e.g. jira's global `--select` flag,
 * which can appear before the subcommand) consumed generically by
 * `stripGlobalFlags` — no more hand-written per-CLI stripping function.
 *
 * Used by: each CLI plugin's `build()`, which validates its own allowlist
 * (via `cli-config-loader.ts`) into the `Record<string, CliConfig>` and
 * passes it into `createCliTool` alongside the real `runCli`.
 */
import { tool, type JSONValue } from "ai";
import { z } from "zod";
import { parseCommand } from "./command-parser.ts";
import type { runCli, CliResult } from "./cli-executor.ts";
import type { StageConfirmation, ExecutableTool } from "@mercury-fw/plugin-types";

// `CliPostProcessor` is part of the plugin contract (a plugin's `build()`
// returns one) — it lives in `@mercury-fw/plugin-types` and is re-exported here
// for the core callers that import it from this module. It runs after every
// allowed command and is told which allowlist prefix matched, so the plugin
// decides what to touch; cli-tool.ts never knows what it does.
import type { CliPostProcessor } from "@mercury-fw/plugin-types";
export type { CliPostProcessor };

export type AllowedCommand = {
  prefix: string[];
  confirm: boolean;
  mutating: boolean;
};
export type GlobalFlag = { flag: string; takesValue: boolean };

export type CliConfig = {
  allowedPrefixes: AllowedCommand[];
  /** Optional declarative global flags (can appear anywhere in argv, not
   * just after the prefix) to strip before prefix-matching. */
  globalFlags?: GlobalFlag[];
};

/**
 * Removes every occurrence of any flag listed in `globalFlags` from
 * `args` (and its value too, if `takesValue`), wherever it appears —
 * generic replacement for what used to be a hand-written per-CLI
 * function (jira's old `stripSelectFlag`). Used only to build a
 * throwaway copy for prefix-matching in `matchCommand`; the original
 * `args` (flags included) is always what actually gets executed.
 */
export function stripGlobalFlags(args: string[], globalFlags: GlobalFlag[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = globalFlags.find((gf) => gf.flag === args[i]);
    if (match) {
      if (match.takesValue) i++; // also skip its value
      continue;
    }
    result.push(args[i] as string);
  }
  return result;
}

export type CommandMatch =
  | { kind: "allowed"; prefix: string[]; mutating: boolean }
  | { kind: "confirm-required"; prefix: string[]; mutating: boolean }
  | { kind: "not-allowed" };

/**
 * Classifies `args` under `config`: `--help` is always `allowed`
 * (discovery, not execution); otherwise `args` (after `config.globalFlags`
 * stripping, if any) is matched positionally against `config.allowedPrefixes`
 * — no match is `not-allowed`, a match with `confirm: false` is `allowed`,
 * a match with `confirm: true` is `confirm-required` (the shape is
 * recognized, but there's no confirmation mechanism to gate it on yet).
 * `mutating` is carried through independently of `confirm` — a command can
 * change external state (Jira, etc.) without requiring confirmation (e.g.
 * create), so the two flags are never derived from one another. An allowed
 * match reports the prefix it matched (`[]` for `--help`), which is what a
 * plugin's post-processor decides on.
 */
export function matchCommand(args: string[], config: CliConfig): CommandMatch {
  if (args[args.length - 1] === "--help") {
    return { kind: "allowed", prefix: [], mutating: false };
  }
  const stripped = config.globalFlags ? stripGlobalFlags(args, config.globalFlags) : args;
  const match = config.allowedPrefixes.find((c) => c.prefix.every((part, i) => stripped[i] === part));
  if (!match) {
    return { kind: "not-allowed" };
  }
  return match.confirm
    ? { kind: "confirm-required", prefix: match.prefix, mutating: match.mutating }
    : { kind: "allowed", prefix: match.prefix, mutating: match.mutating };
}

/** Renders a list of prefixes as a comma-separated string for a
 * model-readable rejection message, e.g. `"issue search, issue get"`. */
export function formatPrefixes(prefixes: string[][]): string {
  return prefixes.map((p) => p.join(" ")).join(", ");
}

/**
 * Removes the top-level `display` channel (see `ToolDisplay`) from a tool
 * result before it reaches the model. `display` is the user-facing channel —
 * a deterministic artifact stashed in the display store and shown only when the
 * model calls `present` (see `display-store.ts`/`present-tool.ts`), never
 * something the model needs to read or reproduce. The model channel is `data`
 * plus the `displayRef` pointer (kept, so the model can `present` it), so this
 * is a structural drop of one known top-level key — not a heuristic removal of
 * a field nested inside `data`. Model-facing notes a plugin adds inside `data`
 * (e.g. `formattedListNote`, telling the model why formatting couldn't happen
 * and how to retry) are on the model channel and pass through.
 */
export function omitDisplayForModel(output: unknown): unknown {
  if (typeof output !== "object" || output === null || !("display" in output)) return output;
  const { display: _display, ...rest } = output as Record<string, unknown>;
  return rest;
}

/**
 * Builds the `runCommand` tool: the model writes a whole CLI invocation as
 * one string, `execute` parses it (`parseCommand`), checks the binary
 * against `configs`, refuses an identity flag (`--user`), then classifies the argv via `matchCommand` — each
 * failure mode (unparseable / identity flag / unknown binary / confirm-required /
 * not-allowed) gets a distinct, self-correctable error message — before
 * ever calling `runCliFn`. `runCliFn` is injected (defaulting to the real
 * `runCli` in production) so tests can supply a fake without spawning a
 * real subprocess.
 *
 * `opts.stageConfirmation` scopes the confirm-required branch: a confirm-gated
 * command is staged (see `confirmation-staging.ts`) instead of running, and the
 * result carries a structured `token` — how the user is actually told to
 * confirm is channel-specific (a card button on Google Chat, a bare token typed
 * on the terminal), not dictated here or by the model (see `confirm-flow.ts` for
 * the other half — actually running it once that token comes back). Staging is
 * inherently per-session (the closure is bound to one sessionKey), so callers
 * must build a fresh tool per turn, scoped to that turn's own session — not a
 * tool meant to be built once and reused across sessions.
 */
export function createCliTool(
  runCliFn: typeof runCli,
  configs: Record<string, CliConfig>,
  opts: {
    /** Stages a confirm-required command's execution behind a token, and writes
     * its paper-trail note (see `StageConfirmation`). Pre-bound to this turn's
     * session/user by the composition root — `cli-tool.ts` never touches the
     * confirmation store or the wiki itself. */
    stageConfirmation: StageConfirmation;
    /** The plugin's post-processor (see `CliPostProcessor`), run on every
     * allowed command's result with the matched prefix — `cli-tool.ts` itself
     * never knows what it does. */
    postProcess?: CliPostProcessor;
    /** Stashes a post-processor's rendered `display` artifact and returns a ref
     * the model can `present`. Pre-bound to this turn's session by the
     * composition root. Optional: with none wired the inline `display` is left
     * untouched and no `displayRef` is minted. */
    stashDisplay?: (artifact: string) => string;
  },
): { runCommand: ExecutableTool } {
  // Anchor the example on a binary this tool actually runs rather than
  // a hardcoded one: a fixed `jira …` example misleads the model on an instance
  // without Jira. The concrete, CLI-specific example (real subcommand + flags)
  // belongs to that CLI's own skill, not to this plugin-agnostic tool.
  const exampleBinary = Object.keys(configs)[0] ?? "<binary>";
  const runCommand = tool({
    description:
      "Run a CLI command. Write the whole invocation as one string, exactly as you would type it in a terminal, " +
      `e.g. \`${exampleBinary} <subcommand> --flag value\`. Quote values that contain spaces.`,
    inputSchema: z.object({ command: z.string().min(1) }),
    execute: async ({ command }) => {
      const parsed = parseCommand(command);
      if (!parsed.ok) {
        return { ok: false, error: `could not parse "${command}": ${parsed.error}` };
      }

      // The CLIs act as whoever `--user <id>` names: which identity a command
      // runs as is Mercury's decision, never something the model writes.
      if (parsed.args.some((a) => a === "--user" || a.startsWith("--user="))) {
        return {
          ok: false,
          error:
            "--user is not allowed: Mercury decides whose account a command runs as, never the command itself. Run it again without --user.",
        };
      }

      const config = configs[parsed.binary];
      if (!config) {
        const known = Object.keys(configs).join(", ") || "(none configured)";
        return {
          ok: false,
          error: `unknown or disabled CLI "${parsed.binary}" on this Mercury instance. Available: ${known}.`,
        };
      }

      const match = matchCommand(parsed.args, config);
      if (match.kind === "not-allowed") {
        const validPrefixes = formatPrefixes(
          config.allowedPrefixes.filter((c) => !c.confirm).map((c) => c.prefix),
        );
        return {
          ok: false,
          error: `not permitted on this Mercury instance. Valid commands: ${validPrefixes}. If "${parsed.args.join(" ")}" doesn't match one of these, it's not a recognized command shape — try again with the right prefix, or run --help to check.`,
        };
      }
      if (match.kind === "confirm-required") {
        // The underlying CLI has its own, separate --confirm safety flag
        // (jira-cli/google-chat-cli both refuse a delete without it) —
        // independent of Mercury's own token. Once a human confirms
        // through Mercury, that flag must actually be there when the
        // staged args run, regardless of whether the model remembered to
        // include it on the first attempt (observed live: it usually
        // doesn't).
        const argsToStage = parsed.args.includes("--confirm") ? parsed.args : [...parsed.args, "--confirm"];
        // Stage the doing as an opaque thunk — the core confirmation subsystem
        // never learns this is a CLI command. `describe` (the normalized argv)
        // is the paper-trail text; `summary` on the result (the raw command the
        // model wrote) is what a channel shows in its confirmation UI.
        const token = await opts.stageConfirmation({
          run: () => runCliFn(parsed.binary, argsToStage),
          describe: [parsed.binary, ...argsToStage].join(" "),
        });
        return {
          ok: false,
          pendingConfirmation: true,
          token,
          summary: command,
          error: `"${match.prefix.join(" ")}" is irreversible and requires explicit confirmation before it can run. Tell the user this action is staged and awaiting their confirmation. Never mention the token value in your reply, in any form — do not tell them how to confirm it, the channel handles that on its own.`,
        };
      }

      const result = await runCliFn(parsed.binary, parsed.args);
      const processed = opts.postProcess
        ? opts.postProcess({ binary: parsed.binary, args: parsed.args, prefix: match.prefix }, result)
        : result;

      // A rendered display artifact is stashed, not returned to be
      // force-appended: the model gets only a `displayRef` and decides whether
      // to `present` it. Only string items (what the formatter renders) are
      // showable; a display still carrying structured items (no formatter
      // applied) has nothing to stash. With no `stashDisplay` wired, the result
      // is left exactly as-is.
      if (opts.stashDisplay && processed.ok && processed.display) {
        const stringItems = processed.display.items.filter((i): i is string => typeof i === "string");
        if (stringItems.length > 0) {
          const displayRef = opts.stashDisplay(stringItems.join("\n\n"));
          return { ...processed, displayRef };
        }
      }
      return processed;
    },
    toModelOutput: ({ output }) => ({ type: "json", value: omitDisplayForModel(output) as JSONValue }),
  });

  return { runCommand };
}
