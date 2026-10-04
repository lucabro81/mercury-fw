/**
 * The terminal channel's `Provider` implementation — wraps
 * `startTerminalRepl` (`src/router/terminal.ts`, unmodified) and owns
 * everything specific to running Mercury from a terminal: the `/dump`
 * command, bare-token confirmation interception, the dim/italic
 * tool-status rendering, and the live context-usage prompt suffix.
 *
 * A single operator, one conversation at a time — there is no real
 * per-user identity here, so `notify` just writes to stderr rather than
 * actually reaching anyone; implemented (not left optional) so a caller
 * that expects a `Notifier` never silently loses a message.
 */
import { startTerminalRepl } from "./terminal.ts";
import { tryConfirm, type ConfirmationStore } from "@mercury-fw/confirm-engine";
import { parseDumpCommand, defaultDumpPath, writeDump, formatContextUsage } from "./tool-log.ts";
import { getLoadedContextLength } from "../model/context-size.ts";
import { detectPendingConfirmation } from "../session/pending-confirmation.ts";
import { PENDING_CONFIRMATION_NOTE } from "../session/agent-turn.ts";
import type { Provider, HandleTurn, TurnSink } from "./provider.ts";
import type { Principal } from "@mercury-fw/channel-types";
import { userKey } from "../identity/user-key.ts";
import type { StepInfo } from "../session/step-info.ts";
import type { writeConfirmationNote } from "../wiki/wiki-note.ts";

const TERMINAL_SESSION_KEY = "terminal";
/** The terminal is a single-user debug console: one fixed principal nobody vouched for, so its sessions stay out of episodic memory. */
const TERMINAL_PRINCIPAL: Principal = { id: "terminal", provider: "none" };

export type TerminalProviderDeps = {
  confirmDeps: {
    store: ConfirmationStore;
    vaultPath: string;
    writeConfirmationNoteFn: typeof writeConfirmationNote;
    now?: () => Date;
  };
  ollamaHost: string;
  ollamaModel: string;
  /** Test seam; defaults to the real `getLoadedContextLength`. */
  getLoadedContextLengthFn?: typeof getLoadedContextLength;
  /** Test seam; defaults to the real `startTerminalRepl`. */
  startTerminalReplFn?: typeof startTerminalRepl;
  /** Test seam; defaults to the real `tryConfirm`. */
  tryConfirmFn?: typeof tryConfirm;
  /** Test seam; defaults to `console.error`. */
  stderrWrite?: (s: string) => void;
};

/** Builds the terminal's `Provider`. */
export function createTerminalProvider(deps: TerminalProviderDeps): Provider {
  const stderrWrite = deps.stderrWrite ?? ((s: string) => console.error(s));
  const getLoadedContextLengthFn = deps.getLoadedContextLengthFn ?? getLoadedContextLength;
  const tryConfirmFn = deps.tryConfirmFn ?? tryConfirm;
  const startTerminalReplFn = deps.startTerminalReplFn ?? startTerminalRepl;

  let lastSteps: StepInfo[] = [];
  let lastInputTokens: number | undefined;
  let contextLength: number | null = null;

  return {
    async start(handleTurn: HandleTurn): Promise<void> {
      await startTerminalReplFn(
        async (input, onChunk) => {
          const dumpCommand = parseDumpCommand(input);
          if (dumpCommand) {
            const path = dumpCommand.path ?? defaultDumpPath();
            await writeDump(path, lastSteps);
            return `wrote ${lastSteps.length} tool step(s) from the last turn to ${path}`;
          }

          // Same deterministic interception as every other channel — never
          // let running a previously-approved mutation depend on the model.
          const confirmReply = await tryConfirmFn(input, TERMINAL_SESSION_KEY, {
            ...deps.confirmDeps,
            owner: userKey(TERMINAL_PRINCIPAL),
          });
          if (confirmReply !== null) {
            // A turn of its own, with no model steps: /dump mustn't show the one before.
            lastSteps = [];
            return confirmReply;
          }

          lastSteps = [];
          let finalText = "";
          // Keyed by the SDK's own reasoning-block id: a tool-calling turn
          // can reason more than once (before a tool call, again after
          // seeing its result), each burst getting its own header/close
          // rather than being mistaken for a continuation of the first.
          const reasoningIdsStarted = new Set<string>();
          // Everything but the answer text is an aside: printed as it comes,
          // but not part of the answer the REPL compares with the result.
          const aside = (chunk: string) => onChunk(chunk, { aside: true });
          const dim = (label: string) => aside(`\x1b[2m\x1b[3m${label}\x1b[0m\n`);
          const sink: TurnSink = {
            onToolStart: dim,
            // PENDING_CONFIRMATION_NOTE is dropped here: onStep (below)
            // already printed the specific instruction (command + token)
            // for the same step — the generic note would be a second,
            // redundant line saying nothing new.
            onTextChunk: (chunk) => {
              if (chunk !== PENDING_CONFIRMATION_NOTE) onChunk(chunk);
            },
            // Only ever fires for a model that actually supports Ollama's
            // extended thinking (see src/index.ts's OLLAMA_THINK) — a
            // non-reasoning model means this is simply never called, so
            // there's no header and no output at all for that turn.
            onReasoningChunk: (chunk, id) => {
              if (!reasoningIdsStarted.has(id)) {
                reasoningIdsStarted.add(id);
                dim("Sto pensando…");
              }
              aside(`\x1b[2m\x1b[3m${chunk}\x1b[0m`);
            },
            onReasoningEnd: (id) => {
              if (reasoningIdsStarted.has(id)) aside("\n");
            },
            onStep: (step) => {
              lastSteps.push(step);
              // cli-tool.ts no longer tells the model to relay a token as
              // text (that's channel-specific now) — the terminal has to
              // say it itself, from the structured step data.
              const pending = detectPendingConfirmation(step);
              if (pending) {
                aside(`Azione in sospeso: \`${pending.summary}\` — scrivi: ${pending.token}\n`);
              }
            },
            onUsage: (tokens) => {
              lastInputTokens = tokens;
            },
            finalize: async (text) => {
              finalText = text;
            },
            dispose: () => {},
          };

          await handleTurn(
            {
              channel: "terminal",
              multiUser: false,
              text: input,
              sessionKey: TERMINAL_SESSION_KEY,
              principal: TERMINAL_PRINCIPAL,
              logPrefix: "",
            },
            sink,
          );

          // Lazy, on-demand: /api/ps only reports models actually loaded,
          // and the model isn't loaded until its first real call.
          if (contextLength === null) {
            contextLength = await getLoadedContextLengthFn(deps.ollamaHost, deps.ollamaModel);
          }
          // The note's chunk was dropped above, so it isn't returned either,
          // also when a surfaced display follows it.
          return finalText.startsWith(PENDING_CONFIRMATION_NOTE)
            ? finalText.slice(PENDING_CONFIRMATION_NOTE.length).replace(/^\n\n/, "")
            : finalText;
        },
        undefined,
        { promptSuffix: () => formatContextUsage(lastInputTokens, contextLength) },
      );
    },

    async notify(userId: string, text: string): Promise<{ sessionKey: string }> {
      stderrWrite(`[notify] to ${userId}: ${text}`);
      return { sessionKey: TERMINAL_SESSION_KEY };
    },
  };
}
