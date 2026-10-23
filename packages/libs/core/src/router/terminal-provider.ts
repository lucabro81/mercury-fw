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
import { resolveConfirmation, type ConfirmationStore } from "@mercury-fw/confirm-engine";
import { parseDumpCommand, defaultDumpPath, writeDump, formatContextUsage } from "./tool-log.ts";
import { getLoadedContextLength } from "../model/context-size.ts";
import { detectPendingConfirmation } from "../session/pending-confirmation.ts";
import type { Provider, HandleTurn, TurnSink } from "./provider.ts";
import { userKey } from "../identity/user-key.ts";
import { OPERATOR_PRINCIPAL } from "../identity/people.ts";
import type { StepInfo } from "../session/step-info.ts";
import type { writeConfirmationNote } from "../wiki/wiki-note.ts";
import { englishTexts, type Texts } from "../i18n/i18n.ts";
import { confirmReply } from "../identity/confirm-binding.ts";

const TERMINAL_SESSION_KEY = "terminal";
/** The terminal is a single-user debug console: one fixed principal nobody vouched for, so its sessions stay out of episodic memory. */
const TERMINAL_PRINCIPAL = OPERATOR_PRINCIPAL;

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
  /** Test seam; defaults to the real `resolveConfirmation`. */
  resolveConfirmationFn?: typeof resolveConfirmation;
  /** Test seam; defaults to `console.error`. */
  stderrWrite?: (s: string) => void;
  /** The texts of its own lines, in the terminal person's language (the app's `texts`); English when absent. */
  texts?: Texts;
};

/** Builds the terminal's `Provider`. */
export function createTerminalProvider(deps: TerminalProviderDeps): Provider {
  const stderrWrite = deps.stderrWrite ?? ((s: string) => console.error(s));
  const getLoadedContextLengthFn = deps.getLoadedContextLengthFn ?? getLoadedContextLength;
  const resolveConfirmationFn = deps.resolveConfirmationFn ?? resolveConfirmation;
  const startTerminalReplFn = deps.startTerminalReplFn ?? startTerminalRepl;
  const texts = deps.texts ?? englishTexts();
  /** The terminal person's texts, read again each time: they can change their language mid-session. */
  const terminalT = () => texts.forPerson(userKey(TERMINAL_PRINCIPAL)).t;

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
          const outcome = await resolveConfirmationFn(input, TERMINAL_SESSION_KEY, {
            ...deps.confirmDeps,
            owner: userKey(TERMINAL_PRINCIPAL),
          });
          const reply = confirmReply(outcome, terminalT());
          if (reply !== null && !reply.resume) {
            // A turn of its own, with no model steps: /dump mustn't show the one before.
            lastSteps = [];
            return reply.text;
          }
          // The confirmed action's result goes back to the model: the session's turn runs again.
          const resuming = reply?.resume === true;

          lastSteps = [];
          const t = terminalT();
          let finalText = "";
          // The core's stand-in for an answer the model didn't write, when the turn ended on one.
          let pendingNote: string | undefined;
          // Keyed by the SDK's own reasoning-block id: a tool-calling turn
          // can reason more than once (before a tool call, again after
          // seeing its result), each burst getting its own header/close
          // rather than being mistaken for a continuation of the first.
          const reasoningIdsStarted = new Set<string>();
          // Whether the last thing written this turn left its line open: the
          // answer streams with no newline at the end, and the turn's log
          // line follows finalize, so finalize closes it.
          let lineOpen = false;
          /** Writes `chunk` through the REPL's onChunk, keeping track of whether its line is still open. */
          const write = (chunk: string, opts?: { aside: true }) => {
            if (chunk !== "") lineOpen = !chunk.endsWith("\n");
            onChunk(chunk, opts);
          };
          // Everything but the answer text is an aside: printed as it comes,
          // but not part of the answer the REPL compares with the result.
          const aside = (chunk: string) => write(chunk, { aside: true });
          const dim = (label: string) => aside(`\x1b[2m\x1b[3m${label}\x1b[0m\n`);
          const sink: TurnSink = {
            onToolStart: dim,
            onTextChunk: (chunk) => write(chunk),
            // Only ever fires for a model that actually supports Ollama's
            // extended thinking (see src/index.ts's OLLAMA_THINK) — a
            // non-reasoning model means this is simply never called, so
            // there's no header and no output at all for that turn.
            onReasoningChunk: (chunk, id) => {
              if (!reasoningIdsStarted.has(id)) {
                reasoningIdsStarted.add(id);
                dim(t("core.terminal.thinking"));
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
              if (pending && pending.choices.length > 1) {
                const lines = pending.choices
                  .map((c) => `  ${t("core.terminal.choice", { label: c.label, token: c.token })}\n`)
                  .join("");
                aside(`${t("core.terminal.pending-choices", { summary: pending.summary })}\n${lines}`);
              } else if (pending) {
                aside(`${t("core.terminal.pending", { summary: pending.summary, token: pending.token })}\n`);
              }
            },
            onUsage: (tokens) => {
              lastInputTokens = tokens;
            },
            finalize: async (text, info) => {
              finalText = text;
              pendingNote = info?.pendingNote;
              if (lineOpen) aside("\n");
            },
            dispose: () => {},
          };

          await handleTurn(
            {
              channel: "terminal",
              multiUser: false,
              text: resuming ? "" : input,
              sessionKey: TERMINAL_SESSION_KEY,
              principal: TERMINAL_PRINCIPAL,
              logPrefix: "",
              ...(resuming ? { resumeAfterConfirm: true as const } : {}),
            },
            sink,
          );

          // Lazy, on-demand: /api/ps only reports models actually loaded,
          // and the model isn't loaded until its first real call.
          if (contextLength === null) {
            contextLength = await getLoadedContextLengthFn(deps.ollamaHost, deps.ollamaModel);
          }
          // The core's pending note isn't printed: onStep already printed
          // the specific instruction (command + token) for the same step, so
          // the generic note would be a second line saying nothing new. Only
          // a list surfaced after it stays.
          return pendingNote !== undefined && finalText.startsWith(pendingNote)
            ? finalText.slice(pendingNote.length).replace(/^\n\n/, "")
            : finalText;
        },
        undefined,
        {
          promptSuffix: () => formatContextUsage(lastInputTokens, contextLength),
          correctedNote: () => terminalT()("core.terminal.corrected"),
        },
      );
    },

    async notify(userId: string, text: string): Promise<{ sessionKey: string }> {
      stderrWrite(`[notify] to ${userId}: ${text}`);
      return { sessionKey: TERMINAL_SESSION_KEY };
    },
  };
}
