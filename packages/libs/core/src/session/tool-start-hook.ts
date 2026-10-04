/**
 * Wraps every tool's `execute` so `onToolStart` fires the moment a call
 * actually begins (before its result is ready), instead of the existing
 * `onStepFinish` visibility (`tool-log.ts`) which only reports after a step
 * already finished, and `onToolFinish` fires once it settles. Used by
 * `src/index.ts`'s `buildTools` for every channel — both terminal and
 * Google Chat always supply a real `onToolStart` (`TurnSink` in
 * `router/provider.ts`), so both are always wrapped.
 *
 * Every wrapped tool's `execute` calls share one `chain` (below), so at
 * most one tool call runs at a time turn-wide — the AI SDK otherwise runs
 * a step's tool calls concurrently (`Promise.all`), which this codebase
 * has never actually relied on; serializing keeps Google Chat's status
 * card for a given `toolCallId` (see `google-chat-provider.ts`) from ever
 * having to handle an overlapping in-flight card.
 */
import type { Tool } from "ai";

// Elenco piccolo e stabile (6 tool totali oggi) — va aggiornato a mano se
// si aggiunge un nuovo tool nominato; qualunque nome non elencato qui
// ricade nel fallback generico, non è un errore. `grep` non è qui: ha una
// propria etichetta ("Sto cercando…"), non ricade nel bucket "read".
const WIKI_TOOL_CATEGORY: Record<string, "read" | "write"> = {
  list_files: "read",
  read_file: "read",
  write_file: "write",
};

/**
 * Describes, in one short user-facing sentence, what a tool call is about to do
 * — no arguments/queries shown. A tool a plugin contributed carries its own
 * label via `toolStatusDescribers` (keyed by tool name), so the core never
 * decides how a plugin's tool reads — it just looks the describer up. The other
 * tools are core functionality (wiki, grep, memory) and keep their core-coined
 * labels until they too become internal plugins.
 */
export function describeToolStart(
  toolName: string,
  input: unknown,
  toolStatusDescribers: Record<string, (input: unknown) => string>,
): string {
  const describe = toolStatusDescribers[toolName];
  if (describe) return describe(input);
  if (toolName === "recall_tool_calls") return "Sto consultando la memoria…";
  if (toolName === "read_skill") return "Sto consultando le istruzioni…";
  if (toolName === "grep") return "Sto cercando…";
  const wikiCategory = WIKI_TOOL_CATEGORY[toolName];
  if (wikiCategory === "read") return "Sto leggendo il wiki…";
  if (wikiCategory === "write") return "Sto scrivendo sul wiki…";
  return `Sto usando ${toolName}…`;
}

const MAX_DETAIL_CHARS = 300;

function truncate(s: string): string {
  return s.length <= MAX_DETAIL_CHARS ? s : `${s.slice(0, MAX_DETAIL_CHARS)}…`;
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input === "object" && input !== null && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * The actual command/input behind a tool call, for display in a status
 * card — `describeToolStart`'s label alone doesn't say *what* ran, only
 * which service. No markdown decoration: Google Chat cards don't render
 * backticks as monospace, so a plain string reads better. Named per-tool
 * (path for a file, pattern for a search, ...) rather than dumping the raw
 * input, since that's what a human actually wants to see; only a genuinely
 * unmapped/future tool falls back to a bounded JSON dump.
 */
export function describeToolDetail(toolName: string, input: unknown): string {
  // Any CLI tool carries a `command` string, whatever its name (jiraCommand,
  // bitbucketCommand, the residual runCommand) — show that bare command.
  const command = stringField(input, "command");
  if (command !== undefined) return truncate(command);
  switch (toolName) {
    case "grep":
      return truncate(stringField(input, "pattern") ?? JSON.stringify(input) ?? "");
    case "read_file":
    case "write_file":
      return truncate(stringField(input, "path") ?? JSON.stringify(input) ?? "");
    case "resolve_reference":
      return truncate(stringField(input, "token") ?? JSON.stringify(input) ?? "");
    case "list_files":
      return "Tutti i documenti del wiki";
    case "recall_tool_calls":
      return "Cronologia delle chiamate in questa conversazione";
    default:
      return truncate(JSON.stringify(input) ?? "");
  }
}

// `ToolOutcome` is part of the channel `TurnSink` contract, so it lives in
// `@mercury-fw/channel-types` and is re-exported here for the core callers that
// import it from this module.
export type { ToolOutcome } from "@mercury-fw/channel-types";
import type { ToolOutcome } from "@mercury-fw/channel-types";

/**
 * Every tool in this codebase returns a uniform `{ok: true, ...}` /
 * `{ok: false, error, ...}` shape (confirmed across `wiki-tools.ts`,
 * `tool-log-recall-tool.ts`, `cli-tool.ts`), with `cli-tool.ts`'s
 * confirm-required staging additionally setting `pendingConfirmation: true`
 * without having actually run the command yet — so this classifier works
 * for any tool without per-tool special-casing. Defaults to `"success"` for
 * an unrecognized result shape; nothing returned by a tool today hits that
 * branch.
 */
export function classifyToolResult(result: unknown): ToolOutcome {
  if (result && typeof result === "object" && "ok" in result) {
    const r = result as { ok?: unknown; pendingConfirmation?: unknown };
    if (r.ok === false) return r.pendingConfirmation === true ? "pending" : "failed";
    if (r.ok === true) return "success";
  }
  return "success";
}

/**
 * Wraps every tool's `execute` to call `onToolStart` first, then run the
 * original, then `onToolFinish` once it settles. `chain` serializes every
 * wrapped tool sharing this one `withToolStartHook` call (i.e. one turn's
 * worth of tools, since `buildTools` builds fresh tools per turn) — see
 * this file's header comment for why.
 */
export function withToolStartHook(
  tools: Record<string, Tool>,
  onToolStart: (label: string, detail?: string, toolCallId?: string, toolName?: string) => void,
  toolStatusDescribers: Record<string, (input: unknown) => string>,
  onToolFinish?: (toolCallId: string, outcome: ToolOutcome) => void,
): Record<string, Tool> {
  let chain: Promise<void> = Promise.resolve();
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    wrapped[name] = {
      ...t,
      execute: (input: unknown, options: { toolCallId: string }) => {
        const label = describeToolStart(name, input, toolStatusDescribers);
        const detail = describeToolDetail(name, input);
        const run = chain.then(async () => {
          onToolStart(label, detail, options.toolCallId, name);
          try {
            const result = await (t.execute as (i: unknown, o: unknown) => unknown)(input, options);
            onToolFinish?.(options.toolCallId, classifyToolResult(result));
            return result;
          } catch (err) {
            onToolFinish?.(options.toolCallId, "failed");
            throw err;
          }
        });
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    } as Tool;
  }
  return wrapped;
}
