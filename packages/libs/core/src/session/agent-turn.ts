/**
 * Orchestrates a single conversational turn: append the user's input to
 * history, ask the model for a response (with access to whichever tools
 * this Mercury instance has wired in), append the response to history,
 * return it.
 *
 * This is the one place that calls `generateText` for the main agent
 * loop (as opposed to `src/session/summarizer.ts`, which calls it for
 * summarization) — see `buildGenerateTextParams` below for why it's
 * `ai-sdk-ollama`'s enhanced version, not the plain `ai` one. The real
 * call is injected as
 * `generateTextFn` so tests can exercise the sequencing/wiring logic
 * here without needing a real model — see the test file for what that
 * does and doesn't cover.
 *
 * Deliberately generic about *what* Mercury can do: `system` and
 * `tools` are both passed in by the caller rather than hardcoded here.
 * A fixed prompt baked into this file describing a specific tool (e.g.
 * "use jiraCli") would be actively wrong on an instance where that tool
 * isn't wired in — the model could still attempt a call to a tool name
 * not present in the request's tool schema, which the AI SDK surfaces
 * as a real error (`NoSuchToolError`), not a harmless no-op. Composing
 * a `system` string that accurately reflects which tools are actually
 * available is `src/index.ts`'s job, since that's where the set of
 * enabled CLIs/tools is decided.
 *
 * Used by: `src/router/turn-runner.ts`'s `createTurnRunner`, the one
 * shared driver every `Provider` (terminal, Google Chat) funnels its
 * turns through (see `src/router/provider.ts`) — `runTurn` itself doesn't
 * know or care which provider a given conversation came from.
 *
 * Streaming (see `buildStreamTextParams`/`runTurn`'s `onTextChunk`) is
 * opt-in: providing `onTextChunk` *or* `onReasoningChunk` switches this
 * call to `streamText`, reading its `fullStream` instead of waiting in
 * silence for a full response — which can take several seconds on the
 * local development model. The terminal provider supplies both (prints
 * the answer and the model's live reasoning to stdout); Google Chat's
 * `TurnSink` supplies only `onReasoningChunk` (a live-patched status card
 * for the model's reasoning) and deliberately never `onTextChunk` — Chat
 * only shows a message once it's fully sent, so incremental *answer*
 * delivery never actually reaches a human faster there, unlike a
 * terminal's live-updating stdout; the reasoning card is a different,
 * already-patchable surface (see `google-chat-provider.ts`'s `createSink`).
 * Either way this function still returns the full answer text and records
 * it as one assistant history entry, same as the plain `generateText` path
 * below — reasoning content is never part of `fullText` or the recorded
 * history entry, it only ever reaches `onReasoningChunk`/`onReasoningEnd`,
 * since it's a live UI-only surface, not something the model should ever
 * see reflected back at it on a later turn.
 */
import { isStepCount, type LanguageModel, type StopCondition, type Tool } from "ai";
import { generateText, streamText } from "ai-sdk-ollama";
import type { Message, SessionHistory } from "./history.ts";
import type { StepInfo } from "./step-info.ts";
import { detectPendingConfirmation } from "./pending-confirmation.ts";
// The sentinel is a channel-side contract value (see `@mercury-fw/channel-types`);
// re-exported here for the core callers importing it from this module.
import { PENDING_CONFIRMATION_NOTE } from "@mercury-fw/channel-types";
export { PENDING_CONFIRMATION_NOTE };

/** `""` unless `lastStep` staged a confirm-required command, in which case `PENDING_CONFIRMATION_NOTE`. */
function resolveEmptyText(lastStep: StepInfo | undefined): string {
  return lastStep && detectPendingConfirmation(lastStep) ? PENDING_CONFIRMATION_NOTE : "";
}

/**
 * What actually gets recorded into `SessionHistory` for this turn — `displayText`
 * unchanged, except when `lastStep` staged a confirm-required command: then
 * it's the opaque `[REQ:<token>]` marker instead, regardless of `displayText`.
 * The two diverge on purpose: `displayText` (what the channel shows/streams)
 * stays the fixed `PENDING_CONFIRMATION_NOTE` sentence — both channels
 * already suppress that exact string and show their own UI instead (a card,
 * a printed instruction) — but that sentence must never reach persistent
 * memory. A confirmation token is ephemeral by design (in-memory only, a
 * few minutes' TTL — see `confirmation-store.ts`), so any summarized record
 * claiming an action is "still pending" goes stale almost immediately;
 * this is the stale-primer bug's actual fix. The marker forces a reader
 * (the model, later, via `context-primer.ts`'s "Open references" +
 * `resolve_reference` in `wiki-tools.ts`) to deliberately look up what it
 * refers to instead of absorbing a claim that may no longer be true.
 */
function resolveHistoryText(lastStep: StepInfo | undefined, displayText: string): string {
  const pending = lastStep ? detectPendingConfirmation(lastStep) : null;
  return pending ? `[REQ:${pending.token}]` : displayText;
}

/**
 * Stops the tool-calling loop immediately after a step that staged a
 * confirm-required command — the model never gets a further step to
 * write anything about it (see `PENDING_CONFIRMATION_NOTE` above for
 * why). `stopWhen` conditions are OR'd together (confirmed against the
 * AI SDK's own source: `isStopConditionMet` resolves every condition and
 * stops if *any* is true), so combining this with `stepCountIs(100)`
 * doesn't change when the step-budget cap itself kicks in.
 */
function pendingConfirmationStop(): StopCondition<any> {
  return ({ steps }) => {
    const last = steps[steps.length - 1];
    return last !== undefined && detectPendingConfirmation(last) !== null;
  };
}

/** The shape of the AI SDK call this module needs, injectable for tests. */
type GenerateTextFn = (params: {
  model: LanguageModel;
  messages: Message[];
  tools: Record<string, Tool>;
  instructions: string;
  onStepEnd?: (step: StepInfo) => void;
  /** Aborts the in-flight generation when the caller cancels the turn. */
  abortSignal?: AbortSignal;
}) => Promise<{ text: string; usage?: { inputTokens: number | undefined }; finishReason?: string }>;

/**
 * Minimal shape this file reads off a `fullStream` part — deliberately a
 * loose supertype of the real (much larger) `TextStreamPart` union `ai`
 * actually emits (`node_modules/ai/dist/index.d.ts:2484`: `start`,
 * `text-start`, `tool-call`, `finish`, etc.), not a closed enumeration of
 * it: a closed union here would reject every part type this file doesn't
 * care about, which the real stream emits plenty of. `delta`/`text` are
 * both optional for the same reason — only present on the part types this
 * file actually reads (`text-delta`/`reasoning-delta`), and the *name* of
 * that field is itself unstable: `ai`'s own `.d.ts` declares this part
 * shape twice with different field names for the same `type` value
 * (`node_modules/ai/dist/index.d.ts:2103-2107` uses `delta`, `2555-2558`
 * uses `text`) — confirmed live against the real `ai-sdk-ollama` stream
 * that the installed version actually emits `text`, not `delta`. Reading
 * both defensively (see the loop below) survives either shape rather than
 * silently reading `undefined` and going empty if a future upgrade flips
 * it back.
 */
type StreamPart = {
  type: string;
  delta?: string;
  text?: string;
  id?: string;
  /** On a `finish` part: how the whole generation ended. */
  finishReason?: string;
  /** On an `error` part: what broke the stream. */
  error?: unknown;
};

/** The shape of the AI SDK streaming call this module needs, injectable for tests. */
type StreamTextFn = (params: {
  model: LanguageModel;
  messages: Message[];
  tools: Record<string, Tool>;
  instructions: string;
  onStepEnd?: (step: StepInfo) => void;
  /** Aborts the in-flight generation when the caller cancels the turn. */
  abortSignal?: AbortSignal;
}) => Promise<{
  stream: AsyncIterable<StreamPart>;
  usage?: PromiseLike<{ inputTokens: number | undefined }>;
}>;

/**
 * Builds the params object passed to the real `generateText`. Extracted
 * as its own pure function so it's unit-testable without a real model —
 * `defaultGenerateTextFn` below is otherwise a thin, untestable wrapper
 * around a direct SDK call.
 *
 * `stopWhen: stepCountIs(100)` is the one non-obvious part: `generateText`
 * defaults to stopping after a single step. If that step is a tool call
 * with no accompanying text (the normal case — the model calls a tool,
 * then needs the tool's result before it can answer), the call returns
 * with `text: ""` and no error, having never given the model a chance to
 * read the tool result and respond — some cap above 1 is needed for
 * that. Raised from an original 5 (observed live: a conversation
 * combining wiki lookups with a jira search — which always needs
 * `--select`, so almost always costs 2 attempts — routinely burned all 5
 * steps on tool calls alone, leaving the model zero steps to ever write
 * an answer) to 20 (matching this SDK's own default for its
 * higher-level agent construct, `ToolLoopAgentSettings`), then to 100 for
 * extra headroom during this research phase — the model should be free
 * to make as many tool calls as it actually needs, not be cut off by an
 * arbitrary ceiling. `runTurn`'s empty-text fallback (below) is the
 * remaining safety net regardless of the cap's value: if a turn still
 * exhausts it with nothing to show, that's communicated explicitly
 * rather than left silent — the real backstop against a runaway loop is
 * that fallback plus the step count itself still being finite, not the
 * specific number.
 *
 * `generateText` itself is imported from `ai-sdk-ollama`, not the plain
 * `ai` package — confirmed by a real run: with the standard SDK's
 * version, Ollama executed the tool call but `text` still came back
 * empty even with multi-step enabled. `ai-sdk-ollama`'s enhanced
 * `generateText` is a drop-in replacement (same params/return shape)
 * that specifically synthesizes a real response when this happens —
 * documented as a known Ollama-provider quirk, not something to patch
 * around here by hand.
 */
export function buildGenerateTextParams(params: {
  model: LanguageModel;
  messages: Message[];
  tools: Record<string, Tool>;
  instructions: string;
  onStepEnd?: (step: StepInfo) => void;
  abortSignal?: AbortSignal;
}) {
  return { ...params, stopWhen: [isStepCount(100), pendingConfirmationStop()] };
}

/** Default production implementation: calls the real `generateText` from `ai`. */
const defaultGenerateTextFn: GenerateTextFn = (params) =>
  generateText(buildGenerateTextParams(params));

/**
 * Builds the params object passed to the real `streamText`. Same
 * `stopWhen` reasoning as `buildGenerateTextParams` — a tool-call-only
 * first step must not be the stream's last step either. `ai-sdk-ollama`'s
 * `streamText` carries its own equivalent of the empty-text-after-
 * tool-call fix (`enableStreamingSynthesis`, on by default) — verified by
 * reading its source before relying on it, not assumed from the
 * non-streaming behavior.
 */
export function buildStreamTextParams(params: {
  model: LanguageModel;
  messages: Message[];
  tools: Record<string, Tool>;
  instructions: string;
  onStepEnd?: (step: StepInfo) => void;
  abortSignal?: AbortSignal;
}) {
  return { ...params, stopWhen: [isStepCount(100), pendingConfirmationStop()] };
}

/** Default production implementation: calls the real `streamText` from `ai-sdk-ollama`. */
const defaultStreamTextFn: StreamTextFn = (params) => streamText(buildStreamTextParams(params));

/**
 * Runs one turn: records `userInput`, generates a response with the
 * given model/tools/system prompt, records the response, and returns it.
 *
 * @param history - The conversation's `SessionHistory`; one per
 *   channel/space, never shared (see `src/index.ts`).
 * @param userInput - The user's message for this turn.
 * @param deps.model - The language model to use.
 * @param deps.tools - The tools available to the model on this call —
 *   which tools end up here depends on which CLIs this Mercury instance
 *   has enabled (see `src/index.ts`), not on anything in this file.
 * @param deps.system - The system prompt for this call. Must accurately
 *   describe only the tools actually present in `deps.tools` — this
 *   function doesn't validate that, the caller is responsible for
 *   keeping the two in sync.
 * @param deps.onStepFinish - Optional, called once per generation step
 *   (including intermediate ones with only a tool call, no text).
 *   `src/router/turn-runner.ts`'s shared `createTurnRunner` wires this for
 *   every provider (fans out to `logStep`/`recordStep`/the provider's own
 *   `TurnSink.onStep`) — what each provider actually *does* with a step
 *   still differs (the terminal prints it, Google Chat's `TurnSink`
 *   doesn't define `onStep` at all, showing raw tool calls to a chat
 *   audience isn't the same call as showing them to whoever's debugging at
 *   a terminal), but the wiring itself is no longer channel-specific.
 * @param deps.onTextChunk - Optional. When provided (alongside or instead
 *   of `onReasoningChunk`), this turn uses `streamText` instead of
 *   `generateText`, calling this once per answer-text chunk as it arrives
 *   — see the file header for why Google Chat never sets this one. The
 *   returned string and the recorded history entry are the same either
 *   way: the full answer text, joined from every `text-delta` chunk only.
 * @param deps.onReasoningChunk - Optional. Also switches this turn onto
 *   `streamText` (see `onTextChunk`). Called once per reasoning-token
 *   delta as it streams, tagged with the SDK's own id for that reasoning
 *   block — only ever fires for a model that actually supports Ollama's
 *   native extended thinking (see `src/index.ts`'s `OLLAMA_THINK`);
 *   otherwise no reasoning parts ever arrive and this is simply never
 *   called. This content is UI-only: it never touches the returned text
 *   or `SessionHistory`. A single turn can reason more than once (e.g.
 *   once before a tool call, again after seeing its result) — each burst
 *   carries its own id, letting a caller (e.g. a status card per id)
 *   treat them as independent rather than one continuous stream.
 * @param deps.onReasoningEnd - Optional. Fires once per reasoning block
 *   that actually started (i.e. once per distinct id `onReasoningChunk`
 *   reported) — including if the stream aborts while a block is still
 *   open, so a caller building a live display (a status card, a printed
 *   block) can't be left stuck open forever. `failed` is `true` only for
 *   that abrupt-abort case, `false` on a normal reasoning-end.
 * @param deps.generateTextFn - Test seam for the non-streaming path;
 *   defaults to the real AI SDK call. Injecting a fake here only tests
 *   this function's own sequencing — it does not exercise the real model
 *   or the real AI SDK integration, which can only be verified by an
 *   actual end-to-end run.
 * @param deps.streamTextFn - Test seam for the streaming path (used when
 *   `onTextChunk`/`onReasoningChunk` is provided), same caveat as
 *   `generateTextFn`.
 * @param deps.onFinish - Optional, called once per turn with how the
 *   generation ended: the AI SDK's `finishReason` (`stop`, `length`,
 *   `error`, ...) from the stream's final `finish` part, or from
 *   `generateText`'s result on the non-streaming path, plus the message of
 *   the stream's `error` part when one came through. Not called when no
 *   reason arrived (a stream that ended on an abort).
 * @param deps.onUsage - Optional, called once per turn with the real
 *   `inputTokens` count the model actually consumed (summed across every
 *   step, including tool calls) — not an estimate. The terminal channel
 *   uses this for a real context-usage indicator (see
 *   `src/router/tool-log.ts`'s `formatContextUsage`); Mercury's own char-
 *   count heuristic in `src/session/history.ts` is for a different
 *   purpose (deciding when to summarize) and intentionally untouched by
 *   this.
 */
export async function runTurn(
  history: SessionHistory,
  userInput: string,
  deps: {
    model: LanguageModel;
    tools: Record<string, Tool>;
    system: string;
    onStepFinish?: (step: StepInfo) => void;
    onTextChunk?: (chunk: string) => void;
    onReasoningChunk?: (chunk: string, id: string) => void;
    onReasoningEnd?: (id: string, failed: boolean) => void;
    onUsage?: (inputTokens: number | undefined) => void;
    onFinish?: (reason: string, error?: string) => void;
    generateTextFn?: GenerateTextFn;
    streamTextFn?: StreamTextFn;
    /** When set, aborting it stops the in-flight generation — the turn ends
     * promptly instead of running to completion (see the HTTP surface's
     * client-disconnect cancellation). Optional; existing callers pass none. */
    abortSignal?: AbortSignal;
  },
): Promise<string> {
  await history.addUserMessage(userInput);

  if (deps.onTextChunk || deps.onReasoningChunk) {
    const stream = deps.streamTextFn ?? defaultStreamTextFn;
    let lastStep: StepInfo | undefined;
    const result = await stream({
      model: deps.model,
      messages: history.getMessages(),
      tools: deps.tools,
      instructions: deps.system,
      abortSignal: deps.abortSignal,
      onStepEnd: (step) => {
        lastStep = step;
        deps.onStepFinish?.(step);
      },
    });

    let fullText = "";
    // The id of the reasoning block currently open, if any — a tool-
    // calling turn can reason multiple times (before a tool call, again
    // after seeing its result, ...), each burst carrying its own id from
    // the SDK. Tracking only the *current* one (not a set of all-ever-seen
    // ids) is enough: it's `undefined` whenever no block is open, which is
    // exactly when the abrupt-failure guard below must stay silent.
    let currentReasoningId: string | undefined;
    let finishReason: string | undefined;
    let streamError: string | undefined;
    try {
      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          const delta = part.text ?? part.delta ?? "";
          fullText += delta;
          deps.onTextChunk?.(delta);
        } else if (part.type === "reasoning-delta") {
          const id = part.id ?? "";
          currentReasoningId = id;
          deps.onReasoningChunk?.(part.text ?? part.delta ?? "", id);
        } else if (part.type === "reasoning-end") {
          const id = part.id ?? "";
          currentReasoningId = undefined;
          deps.onReasoningEnd?.(id, false);
        } else if (part.type === "error") {
          streamError = part.error instanceof Error ? part.error.message : String(part.error);
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
        }
      }
    } finally {
      // Guarantees onReasoningEnd fires even if the stream throws
      // mid-reasoning (no reasoning-end part arrives on an abrupt
      // failure) — a caller building a live display (a status card, a
      // printed block) can't be left stuck open forever. Only fires for
      // whichever block was actually open when the failure happened
      // (`currentReasoningId` is cleared by a normal reasoning-end, so
      // this is a no-op outside an open block). `failed: true` here (vs.
      // `false` on a normal reasoning-end above) is what lets a caller
      // like Google Chat's status card show the right outcome — without
      // it, every abrupt failure would look identical to a clean finish.
      if (currentReasoningId !== undefined) {
        deps.onReasoningEnd?.(currentReasoningId, true);
      }
    }
    deps.onUsage?.((await result.usage)?.inputTokens);
    if (finishReason !== undefined) deps.onFinish?.(finishReason, streamError);

    if (fullText.trim().length === 0) {
      fullText = resolveEmptyText(lastStep);
      if (fullText.length > 0) deps.onTextChunk?.(fullText);
    }

    await history.addAssistantMessage(resolveHistoryText(lastStep, fullText));
    return fullText;
  }

  const generate = deps.generateTextFn ?? defaultGenerateTextFn;
  let lastStep: StepInfo | undefined;
  const result = await generate({
    model: deps.model,
    messages: history.getMessages(),
    tools: deps.tools,
    instructions: deps.system,
    abortSignal: deps.abortSignal,
    onStepEnd: (step) => {
      lastStep = step;
      deps.onStepFinish?.(step);
    },
  });
  deps.onUsage?.(result.usage?.inputTokens);
  if (result.finishReason !== undefined) deps.onFinish?.(result.finishReason);

  const text = result.text.trim().length === 0 ? resolveEmptyText(lastStep) : result.text;
  await history.addAssistantMessage(resolveHistoryText(lastStep, text));
  return text;
}
