/**
 * Deduplicates what `src/index.ts` used to do twice: two near-identical
 * ~50-line closures, one per channel, that (1) tracked the session for
 * Layer-3 capture when the channel has a real per-user identity, (2) ran
 * `runTurn` with a channel-specific tool set/system prompt/output sink,
 * and (3) mirrored new messages to Qdrant and extracted procedural
 * corrections once the turn resolved. `createTurnRunner` is that shared
 * body, parameterized entirely by `Provider`/`InboundTurn`/`TurnSink`
 * (`src/router/provider.ts`) so it doesn't know or care which provider a
 * given turn came from — same channel-agnostic spirit as `runTurn` itself.
 */
import type { LanguageModel, Tool } from "ai";
import { hookCall, type CallRecord } from "../session/call-record.ts";
import type { ContextAssembly, ContextTurn } from "../context/context.ts";
import { ABORTED_MARKER, runTurn } from "../session/agent-turn.ts";
import type { StepInfo } from "../session/step-info.ts";
import { formatTurnStamp } from "../session/turn-stamp.ts";
import { createTurnTrace, type TraceEntry } from "../session/turn-trace.ts";
// `PostTurnGuard` is part of the plugin contract (a plugin's `build()` may
// return these to inspect/rewrite the model's finished text), so it lives in
// `@mercury-fw/plugin-types` and is re-exported here for the core callers that
// import it from this module. No plugin ships one today; the mechanism stays
// generic for future use. A guard that throws is caught by the core and never
// blocks delivery — a guard failure is a quality miss, not a reason to
// withhold an already-generated answer.
import type { HookCall, PostTurnGuard, TurnRecordOfTurn } from "@mercury-fw/plugin-types";
import type { ResumedAction } from "@mercury-fw/confirm-engine";
export type { PostTurnGuard };
import type { Message, SessionHistory } from "../session/history.ts";
import { recordStep } from "../session/tool-log-buffer.ts";
import { shownText } from "../memory/verbatim-archive-store.ts";
import type { HandleTurn, InboundTurn, TurnSink } from "./provider.ts";
import { createPeople, type Identified, type TurnWho } from "../identity/people.ts";
import type { TurnRecordInfo } from "../plugins/plugin-hooks.ts";
export type { TurnWho };

/** What `afterTurn` is told about a finished turn: the session, what the person wrote (empty for a turn the agent opened, or resumed after a confirmation), the answer after the guards, its calls, whether the space is shared. */
export type FinishedTurnInfo = { sessionKey: string; input: string; answer: string; calls: HookCall[]; multiUser: boolean };

import { createSessionLock, type SessionLock } from "./session-lock.ts";
import { englishTexts, type Translate } from "../i18n/i18n.ts";
import { noopTracer, type TraceInput, type Tracer } from "../traces/tracer.ts";
import { stepEvents } from "../traces/step-events.ts";

/** Appended to a one-to-one turn's prompt when the person said how they want to be called. */
export const PREFERRED_NAME_NOTE = (name: string): string =>
  `You're talking with ${name}: that's how they asked to be called, so address them that way.`;

/** Appended to a one-to-one turn's prompt when the person saved a language (`set_preferred_language`): the fixed texts are in it, so the answers must be too. */
export const PREFERRED_LANGUAGE_NOTE = (language: string): string =>
  `The person asked you to talk to them in ${languageName(language)} (${language}): always answer in it.`;

/** `language`'s name in English (`it` → Italian), or the code itself when the runtime doesn't know it. */
function languageName(language: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
  } catch {
    return language;
  }
}

/** Appended to an opening turn's prompt: the person signed in and wrote nothing, and the assistant doesn't know them; `savesName` when the turn has `set_preferred_name` to keep their answer. */
export const OPENING_NOTE = (savesName: boolean): string =>
  "The person just signed in and opened this conversation: they haven't written anything yet, and you don't know their name. " +
  "Introduce yourself briefly, in your own words, then ask the person what name you should use for them, in their language: " +
  "it's their name, not yours, that you're asking for. " +
  (savesName ? "When they answer, save it with set_preferred_name. " : "") +
  "This overrides any instruction not to introduce yourself or not to ask questions.";

/**
 * What an opening turn hands the model as the person's message: the history
 * always opens with one (Ollama refuses a chat without). It stays out of the
 * verbatim archive, so no transcript shows it; the in-context history keeps it,
 * so a summary of the conversation may mention it was opened, which is true.
 */
export const OPENING_CUE = "(The person has just opened the conversation and hasn't written anything yet.)";

/**
 * Appended last to a turn's prompt when lists were shown in the conversation:
 * the history never keeps a list, so without it the model no longer knows
 * which list it showed. Refs and labels only, never the lists.
 */
export const SHOWN_LISTS_NOTE = (shown: Array<{ ref: string; label: string }>): string =>
  [
    "Lists already shown in this conversation (most recent last):",
    ...shown.map(({ ref, label }) => (label ? `- ${ref}: ${label}` : `- ${ref}`)),
    "To show one again, call present with its ref. For up-to-date data, or if present says the ref is gone, run its command again. Never retype a list.",
  ].join("\n");

/** How often a turn still running says so in the log. */
const HEARTBEAT_MS = 60_000;

/** The answer's length: the final text when there is one (a channel that doesn't stream counts nothing on the way), what was streamed otherwise. */
const answerLength = (finalText: string, streamed: number) => (finalText ? finalText.length : streamed);

/** What a stalled turn fails with: `ms` in seconds, decimals kept under a minute. */
const stallMessage = (ms: number) => `the model sent nothing for ${Number((ms / 1000).toFixed(1))}s`;

/**
 * How a generation ended, for a turn that must fail on it: `error` (the
 * stream broke) and `length` (cut at a token limit) leave an answer that
 * only looks complete. Any other reason, an end token mid-word included,
 * can't be told apart from a deliberate end, so it stays a success.
 *
 * @returns The failure's message, or `undefined` when the turn succeeds.
 */
const finishFailure = (finish: { reason: string; error?: string } | undefined) =>
  finish && (finish.reason === "error" || finish.reason === "length")
    ? `the model stopped: ${finish.reason}${finish.error ? ` (${finish.error})` : ""}`
    : undefined;

/** How long a streaming turn waits for the model by default before it's stopped as stalled. */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;

/** `TURN_STALL_TIMEOUT_MS`: unset or empty is the default, otherwise a whole number of milliseconds from 0 up (0 turns the watchdog off); throws on anything else. */
export function parseStallTimeoutMs(text: string | undefined): number {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return DEFAULT_STALL_TIMEOUT_MS;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`TURN_STALL_TIMEOUT_MS must be a whole number of milliseconds from 0 up, got "${trimmed}"`);
  }
  return Number(trimmed);
}

/**
 * A model that stops sending mid-stream (#240) would hang its turn, and the
 * conversation's lock, for good. The watchdog fires `onStall` once `ms` pass
 * with no `kick`; `pause`/`resume` hold it while a tool runs, since a slow tool
 * isn't a silent model. With `ms` 0 it never arms.
 */
function createWatchdog(ms: number, onStall: () => void, setTimer: (fn: () => void, ms: number) => () => void) {
  let cancel: (() => void) | undefined;
  let paused = 0;
  let stopped = ms <= 0;
  const disarm = () => {
    cancel?.();
    cancel = undefined;
  };
  const arm = () => {
    disarm();
    if (!stopped && paused === 0) cancel = setTimer(onStall, ms);
  };
  arm();
  return {
    kick: arm,
    pause: () => {
      paused += 1;
      disarm();
    },
    resume: () => {
      paused = Math.max(0, paused - 1);
      arm();
    },
    stop: () => {
      stopped = true;
      disarm();
    },
  };
}

/** `n` and its noun, singular for one. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export type TurnRunnerDeps = {
  model: LanguageModel;
  /** Both variants, precomposed by the composition root; selected per turn by `turn.multiUser`. Used when `systemPromptsFor` is absent. */
  systemPrompts: { singleUser: string; multiUser: string };
  /** The prompts for what `who` is offered (see `plugins/offering.ts`); `systemPrompts` for everyone when absent. */
  systemPromptsFor?: (who: TurnWho) => { singleUser: string; multiUser: string };
  /**
   * Who the turn's principal is (see `identity/people.ts`); refused, the turn
   * answers the refusal and runs nothing. Defaults to no directory: the person
   * is whoever the channel says.
   */
  identify?: (principal: InboundTurn["principal"], hint?: string) => Promise<Identified>;
  /** Takes what a confirmation kept for the session's resumed turn (see
   * `InboundTurn.resumeAfterConfirm`); nothing is ever kept when absent. */
  takeResumed?: (sessionKey: string) => ResumedAction | undefined;
  /** The lists shown in the session, most recent last (see `display-store.ts`); none when absent. */
  shownLists?: (sessionKey: string) => Array<{ ref: string; label: string }>;
  /** How the person with `key` asked to be called, or undefined; nobody has a name when absent. */
  preferredName?: (key: string) => string | undefined;
  /** The language the person with `key` saved, or undefined; nobody has one when absent. */
  preferredLanguage?: (key: string) => string | undefined;
  /**
   * The time zone the turn of the person with `key` is stamped in, given the
   * channel's hint (see `session/turn-stamp.ts`): the model reads each message
   * after when and where it was written. Turns go unstamped when absent.
   */
  timeZoneFor?: (key: string, hint: string | undefined) => string;
  /** `key` is the person's key, `who` whom the tools are offered to and act for. */
  buildTools: (
    sessionKey: string,
    key: string,
    who: TurnWho,
    onToolStart?: TurnSink["onToolStart"],
    onToolFinish?: TurnSink["onToolFinish"],
    /** The channel's language hint (`InboundTurn.languageHint`), for the tools' texts. */
    languageHint?: string,
  ) => Record<string, Tool>;
  /**
   * `key` is the user key, forwarded (not interpreted here) so a provider's
   * own closure can decide whether to seed a first-ever session with a
   * context primer (see `src/session/context-primer.ts`); `undefined` when
   * nobody vouched for the person, since a primer needs a real identity.
   * `resume` is the turn's own (`InboundTurn.resume`), for a tracked turn
   * only: a history created for it is rebuilt from the archive, its person's
   * messages stamped in `timeZone`, the turn's, when there is one. `who` is
   * whom the turn is for: a new session keeps its conversation with the
   * plugin their context profile names.
   */
  getOrCreateHistory: (
    sessionKey: string,
    trackForCapture: boolean,
    key: string | undefined,
    resume: InboundTurn["resume"] | undefined,
    timeZone: string | undefined,
    who: TurnWho,
  ) => Promise<SessionHistory> | SessionHistory;
  /** The session's activity, for the idle sweep that closes it (the scanner's touch). Only for turns whose person a provider vouched for. */
  trackSession: (sessionKey: string, key: string, at: number) => void;
  /**
   * Told what every turn that ran left (#393), whatever its outcome, once the
   * turn is over: the composition root hands it to the plugins'
   * `onTurnRecord` hooks. `answer` is set on a done turn, and on a cancelled
   * one only when this turn's model call left the history its placeholder,
   * so what's kept matches the history. Called, never awaited; a throw is
   * logged.
   */
  turnRecord?: (who: TurnWho, record: TurnRecordInfo) => void;
  /**
   * Counts the turn on the turn model from the moment it arrives (before it
   * waits for its session) until its answer is out, so the work nobody waits
   * on leaves the model to it (#383). Returns the release, which may be called
   * more than once. Absent, nothing is counted.
   */
  holdTurn?: () => () => void;
  logStep: (prefix: string, step: StepInfo) => void;
  /** Test seam; defaults to the real `recordStep`. */
  recordStepFn?: typeof recordStep;
  /** Test seam; defaults to the real `runTurn`. */
  runTurnFn?: typeof runTurn;
  /**
   * Post-turn guards contributed by loaded plugins, run in order over the
   * model's finished text (see `PostTurnGuard`). Empty/absent on an instance
   * with no plugin that registers one. The composition root builds these; the
   * core knows nothing about what any of them does.
   */
  postTurnGuards?: PostTurnGuard[];
  /**
   * Told about every turn that ended with an answer, once the person has it:
   * who wrote it and what the turn was (`FinishedTurn` without what depends
   * on the plugin). The composition root hands it to the plugins' `afterTurn`
   * hooks. Called, never awaited; a throw is logged.
   */
  afterTurn?: (who: TurnWho, turn: FinishedTurnInfo) => void;
  /**
   * What the instance's context adds to the turn (#387): the session layers'
   * text for the system prompt, the turn layers' text for the model call,
   * and what the `context.assembled` event reports. Absent, or failing, the
   * turn goes without.
   */
  contextFor?: (who: TurnWho, turn: ContextTurn) => Promise<ContextAssembly>;
  /** The texts of the person with `key` on a channel hinting `hint`, for what the turn shows them that isn't the model's; English when absent. */
  translatorFor?: (key: string, hint?: string) => Translate;
  /**
   * Test seam; defaults to `console.log`. Receives a guard's own `log` line,
   * or the core's own note when a guard throws. Exists to measure real-world
   * guard frequency before investing further.
   */
  logPostTurnGuardFn?: (message: string) => void;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
  /** Where the turn's events go (#23): its start and end, each model step and tool call, the guards; nowhere when absent. */
  tracer?: Tracer;
  /** Test seam: the id tying a turn's events (and its archived messages) together; defaults to a random UUID. */
  newTurnId?: () => string;
  /** Where the turn log goes (start, end, failure, still running); defaults to stderr. */
  logTurnFn?: (line: string) => void;
  /** Test seam: runs `fn` every `ms` until the returned stop is called; defaults to `setInterval`. */
  heartbeat?: (fn: () => void, ms: number) => () => void;
  /**
   * How long a streaming turn waits for the model's next chunk or step before
   * it's stopped as stalled (`TURN_STALL_TIMEOUT_MS`); off when absent or 0.
   * A channel that doesn't stream only hears from the model at the end of each
   * step, so it never gets the watchdog.
   */
  stallTimeoutMs?: number;
  /** Test seam: runs `fn` once after `ms` unless the returned cancel is called first; defaults to `setTimeout`. */
  stallTimer?: (fn: () => void, ms: number) => () => void;
  /**
   * Returns the display artifacts surfaced this turn (see `display-store.ts`),
   * by the model through `present` or shown always by the instance's rule, in
   * stash order, to append after the model's text. Absent on an instance with no display store — nothing is appended.
   * The old unconditional splicing of every tool-produced display is gone:
   * an artifact is shown only when the model explicitly presented it.
   */
  takeSurfacedDisplays?: (sessionKey: string) => string[];
  /**
   * Drops what this turn marked to show (presented, or shown always) and no
   * finalize took: called once every turn is over, so a failed or cancelled
   * turn's displays aren't appended to the next one. A no-op after a
   * finalize, which already took them.
   */
  discardSurfacedDisplays?: (sessionKey: string) => void;
  /**
   * Serialises everything that touches one session: this runner's turns and
   * whatever else the composition root runs on a session (the idle sweep).
   * Defaults to a lock of the runner's own.
   */
  sessionLock?: SessionLock;
};

/** What stands for the person's message in a turn resumed after a
 * confirmation: which action they confirmed and the choice they took. Written
 * by the core, never carrying the action's result. */
export const RESUMED_LINE = (resumed: ResumedAction) =>
  `[Confirmed by the person: ${resumed.describe}${resumed.label === undefined ? "" : ` (${resumed.label})`}]`;

/** The confirmed action as a step of the resumed turn, for the post-turn guards. */
function resumedStep(resumed: ResumedAction): StepInfo {
  const toolCallId = "resumed";
  return {
    toolCalls: [{ toolCallId, toolName: resumed.toolName, input: resumed.input }],
    toolResults: [{ toolCallId, toolName: resumed.toolName, output: resumed.output }],
    content: [],
  };
}

/** Builds the shared `HandleTurn` every provider's driver calls once it has a real message to run through the model. */
export function createTurnRunner(deps: TurnRunnerDeps): HandleTurn {
  const postTurnGuards = deps.postTurnGuards ?? [];
  const logPostTurnGuard = deps.logPostTurnGuardFn ?? ((message: string) => console.log(message));
  const sessionLock = deps.sessionLock ?? createSessionLock();
  const identify = deps.identify ?? createPeople({ directory: "none" }).identify;

  // One turn at a time per session, post-turn work included (it reads the
  // history and the capture markers); a turn whose client went away while
  // it waited never starts, but its sink is still released.
  return async (turn: InboundTurn, sink: TurnSink): Promise<void> => {
    const releaseTurn = deps.holdTurn?.() ?? (() => {});
    let started = false;
    try {
      await sessionLock.run(
        turn.sessionKey,
        () => {
          started = true;
          return runTurnLocked(turn, sink, releaseTurn);
        },
        turn.abortSignal,
      );
    } finally {
      releaseTurn();
    }
    if (!started) sink.dispose();
  };

  async function runTurnLocked(turn: InboundTurn, channelSink: TurnSink, releaseTurn: () => void): Promise<void> {
    // What the person sees of the turn besides its text, kept with the answer (#370).
    const trace = createTurnTrace(channelSink);
    const sink = trace.sink;
    const turnId = (deps.newTurnId ?? (() => crypto.randomUUID()))();
    const tracer = deps.tracer ?? noopTracer;
    /** Emits `input` as one of this turn's events, with the person once they're known. */
    const emit = (input: TraceInput, person?: string) =>
      tracer.emit({ ...input, turn: turnId, session: turn.sessionKey, ...(person === undefined ? {} : { person }) });
    // Someone the core won't talk to gets the refusal, and nothing of theirs
    // is created: no history, no capture.
    const identified = await identify(turn.principal, turn.languageHint);
    if (!identified.ok) {
      emit({ kind: "turn.end", outcome: "refused" });
      try {
        await sink.finalize(identified.message);
      } finally {
        sink.dispose();
      }
      return;
    }
    const who: TurnWho = { person: identified.person, operator: identified.operator };
    // The person's key is what every per-person store uses. The operator still
    // gets one, so its wiki area works like anyone's, but it's never tracked
    // for Layer-3 capture.
    const key = who.person.key;
    const tracked = !who.operator;
    emit(
      {
        kind: "turn.start",
        channel: turn.channel,
        opening: turn.opening === true,
        resumed: turn.resumeAfterConfirm === true,
        multiUser: turn.multiUser,
      },
      key,
    );
    // The turn's texts that aren't the model's: the pending note, the guards'.
    const t = deps.translatorFor?.(key, turn.languageHint) ?? englishTexts().forPerson(undefined).t;
    const pendingNote = t("core.pending.note");
    let noteUsed = false;
    const prompts = deps.systemPromptsFor?.(who) ?? deps.systemPrompts;
    // A shared space names each sender in their messages; one person's name is
    // only for a one-to-one turn.
    const name = turn.multiUser ? undefined : deps.preferredName?.(key);
    const language = turn.multiUser ? undefined : deps.preferredLanguage?.(key);
    // Speaking first is only for someone it doesn't know yet, one to one:
    // otherwise an opening says nothing and leaves nothing behind.
    if (turn.opening && (turn.multiUser || name !== undefined)) {
      emit({ kind: "turn.end", outcome: "opening-skipped" }, key);
      try {
        await sink.finalize("");
      } finally {
        sink.dispose();
      }
      return;
    }
    const resumed = turn.resumeAfterConfirm ? deps.takeResumed?.(turn.sessionKey) : undefined;
    // Nothing kept to resume with (already taken, expired, or lost to a
    // restart): said, since an empty answer reads like the model's.
    if (turn.resumeAfterConfirm && resumed === undefined) {
      emit({ kind: "turn.end", outcome: "resume-gone" }, key);
      try {
        await sink.finalize(t("core.resume.gone"));
      } finally {
        sink.dispose();
      }
      return;
    }
    const shown = deps.shownLists?.(turn.sessionKey) ?? [];
    /** The turn's prompt; the primer comes with the history: the state the model uses as is. */
    const systemFor = (primer: { current: string } | undefined, context: string | undefined, savesName: boolean) =>
      [
        // A resumed turn answers the person who confirmed, even in a shared
        // space: the multi-user prompt would let the model stay silent on it.
        turn.multiUser && !resumed ? prompts.multiUser : prompts.singleUser,
        ...(primer?.current ? [primer.current] : []),
        ...(context ? [context] : []),
        ...(turn.opening ? [OPENING_NOTE(savesName)] : name === undefined ? [] : [PREFERRED_NAME_NOTE(name)]),
        ...(language === undefined ? [] : [PREFERRED_LANGUAGE_NOTE(language)]),
        // Last, where a small model pays the most attention.
        ...(shown.length > 0 ? [SHOWN_LISTS_NOTE(shown)] : []),
      ].join("\n\n");
    const message = resumed ? RESUMED_LINE(resumed) : turn.opening ? OPENING_CUE : turn.text;
    // On the model's input only: the archive keeps `turn.text` and its own timestamp.
    const timeZone = deps.timeZoneFor?.(key, turn.timeZoneHint);
    const input = timeZone === undefined ? message : `${formatTurnStamp(new Date((deps.now ?? Date.now)()), timeZone)}${message}`;
    if (tracked) {
      deps.trackSession(turn.sessionKey, key, (deps.now ?? Date.now)());
    }

    // The turn log (#238): a turn with no tool calls, or one that never ends,
    // would otherwise leave no trace at all.
    const now = deps.now ?? Date.now;
    const logTurn = deps.logTurnFn ?? ((line: string) => console.error(line));
    const startedAt = now();
    const seconds = () => ((now() - startedAt) / 1000).toFixed(1);
    let reasoningChars = 0;
    let answerChars = 0;
    let toolCalls = 0;
    let finish: { reason: string; error?: string } | undefined;
    /** The turn's last event: how it ended and what it took. */
    const endTurn = (outcome: string, args?: Record<string, unknown>) =>
      emit(
        {
          kind: "turn.end",
          outcome,
          durationMs: now() - startedAt,
          steps: steps.length,
          toolCalls,
          answerChars: answerLength(assistantText, answerChars),
          reasoningChars,
          ...(finish === undefined ? {} : { finishReason: finish.reason }),
          stoodIn,
          ...(args === undefined ? {} : { args }),
        },
        key,
      );
    logTurn(`${turn.logPrefix}[turn] start${turn.opening ? " (opening)" : ""}`);
    const stopHeartbeat = (
      deps.heartbeat ??
      ((fn, ms) => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      })
    )(
      () =>
        logTurn(
          `${turn.logPrefix}[turn] still running after ${Math.round((now() - startedAt) / 1000)}s: reasoning ${reasoningChars} chars, answer ${answerChars} chars, ${count(toolCalls, "tool call")}`,
        ),
      HEARTBEAT_MS,
    );

    // Only a streaming turn hears from the model as it goes (see stallTimeoutMs).
    const stallMs = sink.onTextChunk || sink.onReasoningChunk ? (deps.stallTimeoutMs ?? 0) : 0;
    const watching = stallMs > 0;
    const stall = new AbortController();
    let stalled = false;
    // Armed right before the model is called: building the history (a Qdrant
    // read) isn't the model's silence.
    let watchdog = createWatchdog(0, () => {}, () => () => {});

    const steps: StepInfo[] = [];
    let history: SessionHistory;
    // The model's own answer text (post-guards, before any surfaced `present`
    // display is appended) — what the verbatim archive stores as the
    // assistant's message. Assigned once the turn resolves successfully.
    let assistantText = "";
    // What the model surfaced with `present` this turn, archived next to it.
    let surfacedDisplays: string[] = [];
    // Whether the answer begins with the core's pending note, standing in for the model's words.
    let stoodIn = false;
    // The history's last message before this turn: a marker that is still it was left by an earlier turn.
    let lastBefore: Message | undefined;
    // Set when the turn's channel cancelled it: archived once the sink is released.
    let cancelled = false;
    // Set when the turn failed (a stall included): recorded once the sink is released.
    let failed = false;

    /** The turn's record (see `TurnRunnerDeps.turnRecord`): how it ended and, when it left one, its answer. */
    function recordTurn(outcome: TurnRecordOfTurn["outcome"], answer?: TurnRecordOfTurn["answer"]): void {
      if (!deps.turnRecord) return;
      const origin = turn.opening ? "opening" : resumed ? "resumed" : "person";
      try {
        deps.turnRecord(who, {
          sessionKey: turn.sessionKey,
          kind: "turn",
          turnId,
          multiUser: turn.multiUser,
          outcome,
          origin,
          ...(origin === "person" ? { input: turn.text } : {}),
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(now()).toISOString(),
          ...(answer === undefined ? {} : { answer }),
        });
      } catch (err) {
        console.log(`[hooks] turn record failed, turn unaffected: ${String(err instanceof Error ? err.message : err)}`);
      }
    }

    /**
     * What a cancelled turn leaves (#366): an answer marked as interrupted,
     * with the text the history kept in its place and what the person saw
     * up to the stop; nothing when this turn's model call didn't record that
     * text, so what's kept matches the history.
     */
    function interruptedAnswer(): TurnRecordOfTurn["answer"] {
      const last = history?.getMessages().at(-1);
      if (last === lastBefore || last?.content !== ABORTED_MARKER) return undefined;
      const seen = trace.entries();
      return { content: ABORTED_MARKER, interrupted: true, ...(seen.length > 0 ? { trace: seen } : {}) };
    }

    try {
      // Inside the try, not before it: a failure building the history
      // (e.g. the context-primer's Qdrant query) must still release the
      // sink (see TurnSink.dispose's doc comment) — a stuck-note timer
      // already scheduled when the sink was constructed keeps running
      // otherwise, firing on its own 60s schedule regardless of whether
      // the turn itself already failed and was reported.
      history = await deps.getOrCreateHistory(
        turn.sessionKey,
        tracked,
        tracked ? key : undefined,
        tracked ? turn.resume : undefined,
        tracked ? timeZone : undefined,
        who,
      );
      lastBefore = history.getMessages().at(-1);
      watchdog = createWatchdog(
        stallMs,
        () => {
          stalled = true;
          stall.abort();
        },
        deps.stallTimer ??
          ((fn, ms) => {
            const id = setTimeout(fn, ms);
            return () => clearTimeout(id);
          }),
      );
      // What the instance's context adds: never a reason for the turn to fail.
      let context: ContextAssembly | undefined;
      if (deps.contextFor) {
        try {
          context = await deps.contextFor(who, {
            sessionKey: turn.sessionKey,
            input: turn.opening || resumed ? "" : turn.text,
            multiUser: turn.multiUser,
            // Only someone vouched for has conversations to reopen.
            reopened: tracked && turn.resume !== undefined,
          });
          emit({ kind: "context.assembled", ...context.event }, key);
        } catch (err) {
          logTurn(`${turn.logPrefix}[context] failed, the turn goes without: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const tools = watching
        ? deps.buildTools(
            turn.sessionKey,
            key,
            who,
            (...args) => {
              watchdog.pause();
              sink.onToolStart(...args);
            },
            (toolCallId, outcome) => {
              watchdog.resume();
              sink.onToolFinish?.(toolCallId, outcome);
            },
            turn.languageHint,
          )
        : deps.buildTools(turn.sessionKey, key, who, sink.onToolStart, sink.onToolFinish, turn.languageHint);
      const text = await (deps.runTurnFn ?? runTurn)(history, input, {
        model: deps.model,
        tools,
        pendingNote,
        loginNote: (services) =>
          services.length === 0 ? t("core.login.note-any") : t("core.login.note", { services: services.join(", ") }),
        onPendingNote: () => {
          noteUsed = true;
        },
        system: systemFor(history.primer(), context?.system, "set_preferred_name" in tools),
        ...(context?.turn === undefined ? {} : { turnContext: context.turn }),
        // Counted on the way through, and only where the channel streams: an
        // absent callback keeps the turn on the non-streaming path.
        ...(sink.onTextChunk
          ? {
              onTextChunk: (chunk: string) => {
                watchdog.kick();
                answerChars += chunk.length;
                sink.onTextChunk!(chunk);
              },
            }
          : {}),
        ...(sink.onReasoningChunk
          ? {
              onReasoningChunk: (chunk: string, id: string) => {
                watchdog.kick();
                reasoningChars += chunk.length;
                sink.onReasoningChunk!(chunk, id);
              },
            }
          : {}),
        onReasoningEnd: sink.onReasoningEnd,
        onStepFinish: (step) => {
          watchdog.kick();
          steps.push(step);
          toolCalls += step.toolCalls.length;
          deps.logStep(turn.logPrefix, step);
          for (const event of stepEvents(step)) emit(event, key);
          (deps.recordStepFn ?? recordStep)(turn.channel, turn.sessionKey, key, step);
          sink.onStep?.(step);
        },
        onUsage: sink.onUsage,
        onFinish: (reason, error) => {
          finish = { reason, error };
        },
        abortSignal: watching
          ? turn.abortSignal
            ? AbortSignal.any([turn.abortSignal, stall.signal])
            : stall.signal
          : turn.abortSignal,
        ...(resumed ? { resumed } : {}),
      });
      // The model is done: what's left (guards, finalize) isn't its silence.
      watchdog.stop();
      // The AI SDK doesn't throw when its signal aborts: the stream ends and
      // the call returns what it had. A stall is a failure all the same.
      if (stalled && !turn.abortSignal?.aborted) throw new Error(stallMessage(stallMs));
      // The person stopped it: what the call had isn't an answer, so nothing
      // of it is guarded, delivered or archived.
      if (turn.abortSignal?.aborted) {
        logTurn(`${turn.logPrefix}[turn] cancelled after ${seconds()}s`);
        endTurn("cancelled");
        cancelled = true;
        return;
      }
      const cut = finishFailure(finish);
      if (cut !== undefined) throw new Error(cut);

      let correctedText = text;
      // Plugin-contributed post-turn guards, run in order. `shouldRun` gates
      // both the rewrite and its status indicator (so a guard that doesn't
      // engage shows nothing), and reuses the same onToolStart/onToolFinish
      // machinery already shared with real tool calls and Layer-3 capture pings
      // — terminal's dim-print and Google Chat's status-card patching both
      // handle any (label, detail?, toolCallId?) triple generically. A guard
      // that throws is caught here and never blocks delivery.
      const guardSteps = resumed ? [resumedStep(resumed), ...steps] : steps;
      for (const guard of postTurnGuards) {
        if (!guard.shouldRun(correctedText, guardSteps)) {
          continue;
        }
        // The status line is the guard's code too: it fails like its run.
        let started = false;
        try {
          sink.onToolStart(guard.statusLabel(t), undefined, guard.statusId);
          started = true;
          const guarded = await guard.run(correctedText, guardSteps, t);
          sink.onToolFinish?.(guard.statusId, guarded.outcome);
          emit({ kind: "guard.run", guard: guard.statusId, outcome: guarded.outcome, changed: guarded.text !== correctedText }, key);
          if (guarded.log !== undefined) {
            logPostTurnGuard(guarded.log);
          }
          correctedText = guarded.text;
        } catch (err) {
          if (started) sink.onToolFinish?.(guard.statusId, "failed");
          emit({ kind: "guard.run", guard: guard.statusId, outcome: "failed", changed: false, args: { error: String(err instanceof Error ? err.message : err) } }, key);
          logPostTurnGuard(
            `[post-turn-guard] guard "${guard.statusId}" threw, kept text unchanged: ${String(err instanceof Error ? err.message : err)}`,
          );
        }
      }

      if (correctedText !== text) {
        history.replaceLastAssistantMessage(correctedText);
      }
      assistantText = correctedText;

      // Append only what was surfaced this turn — what the model chose to
      // `present`, and what the instance shows always — never the whole set
      // of tool-produced displays. Appending (not replacing) keeps
      // the already-streamed prefix intact, so terminal.ts's safe-slice holds.
      surfacedDisplays = deps.takeSurfacedDisplays?.(turn.sessionKey) ?? [];
      const finalText = shownText(correctedText, surfacedDisplays);
      // The model said nothing and the turn stood in with the note: the
      // channel is told, never left to recognize the text, also when a
      // guard added to it.
      stoodIn = noteUsed && correctedText.startsWith(pendingNote);
      if (stoodIn) await sink.finalize(finalText, { pendingNote });
      else await sink.finalize(finalText);
      // The answer is out: from here on the turn needs the model no more.
      releaseTurn();
      endTurn("done");
      logTurn(
        `${turn.logPrefix}[turn] done in ${seconds()}s: ${count(steps.length, "step")}, ${count(toolCalls, "tool call")}, reasoning ${reasoningChars} chars, answer ${answerLength(assistantText, answerChars)} chars${finish ? `, finish ${finish.reason}` : ""}`,
      );
    } catch (err) {
      // A turn its channel cancelled is a cancel, even if the watchdog fired meanwhile.
      if (stalled && !turn.abortSignal?.aborted) {
        const message = stallMessage(stallMs);
        logTurn(`${turn.logPrefix}[turn] stalled after ${seconds()}s: ${message}`);
        endTurn("stalled");
        failed = true;
        throw err instanceof Error && err.message === message ? err : new Error(message);
      }
      // A cancel isn't a failure: the channel that asked for it knows.
      if (turn.abortSignal?.aborted) {
        logTurn(`${turn.logPrefix}[turn] cancelled after ${seconds()}s`);
        endTurn("cancelled");
        cancelled = true;
        return;
      }
      endTurn("failed", { error: err instanceof Error ? err.message : String(err) });
      failed = true;
      logTurn(`${turn.logPrefix}[turn] failed after ${seconds()}s: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      watchdog.stop();
      stopHeartbeat();
      deps.discardSurfacedDisplays?.(turn.sessionKey);
      sink.dispose();
      if (cancelled) {
        if (tracked) deps.trackSession(turn.sessionKey, key, (deps.now ?? Date.now)());
        recordTurn("cancelled", interruptedAnswer());
      } else if (failed) recordTurn("failed");
    }

    // The person has the answer: the plugins hear the turn now, whatever the capture below does.
    if (deps.afterTurn) {
      const last = history.getMessages().at(-1);
      const calls = last?.role === "assistant" ? (last.calls ?? []) : [];
      try {
        deps.afterTurn(who, {
          sessionKey: turn.sessionKey,
          input: turn.opening || resumed ? "" : turn.text,
          answer: assistantText,
          calls: calls.map(hookCall),
          multiUser: turn.multiUser,
        });
      } catch (err) {
        console.log(`[hooks] afterTurn failed, turn unaffected: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
    if (tracked) {
      // Activity at the end too: a turn longer than the idle timeout must not
      // look idle the moment it ends.
      deps.trackSession(turn.sessionKey, key, (deps.now ?? Date.now)());
    }
    // What the turn left, for the plugins keeping it: the calls the answer was written from, as the history recorded them.
    const answered = history.getMessages().at(-1);
    const answeredCalls = answered?.role === "assistant" ? answered.calls : undefined;
    const seen = trace.entries();
    recordTurn("done", {
      content: assistantText,
      ...(surfacedDisplays.length > 0 ? { displays: surfacedDisplays } : {}),
      ...(answeredCalls !== undefined ? { calls: answeredCalls } : {}),
      ...(seen.length > 0 ? { trace: seen } : {}),
      ...(stoodIn ? { pendingNote } : {}),
    });
  }
}
