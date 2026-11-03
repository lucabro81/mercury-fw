/**
 * What a person saw of a turn besides its text, recorded as it happens so the
 * archive can keep it with the answer (#370): the reasoning, block by block;
 * the status lines of the tools (and of the guards and capture pings that use
 * the same callbacks), with their outcome; the confirmations staged; the
 * logins asked for. A UI reopening the conversation shows it as the live turn
 * did. It is for the person only: nothing of it goes back to the model.
 *
 * No token and no login link ever lands here: a confirmation is named by
 * `confirmationId` of its first token, enough to match it with how it was
 * resolved, and a login by its service.
 */
import { createHash } from "node:crypto";
import { detectLoginRequests, detectPendingConfirmation, type ToolOutcome, type TurnSink } from "@mercury-fw/channel-types";

/** One thing the person saw during a turn, in the order it happened. */
export type TraceEntry =
  | { type: "reasoning"; text: string; failed?: true }
  | { type: "tool"; label: string; detail?: string; name?: string; outcome?: ToolOutcome }
  | { type: "confirmation"; id: string; command: string; choices: string[] }
  | { type: "login"; service: string };

/** How the archive names a confirmation: a short hash of its first token, which is no confirm capability. */
export function confirmationId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export type TurnTrace = {
  /** `sink`, forwarding every call unchanged, recording along the way. */
  sink: TurnSink;
  /** What was recorded so far, as a copy. */
  entries: () => TraceEntry[];
};

/**
 * Wraps `sink` to record the turn's trace. The streaming callbacks stay absent
 * when `sink` has none, since their presence puts the turn on `streamText`.
 */
export function createTurnTrace(sink: TurnSink): TurnTrace {
  const entries: TraceEntry[] = [];
  const reasoning = new Map<string, Extract<TraceEntry, { type: "reasoning" }>>();
  const tools = new Map<string, Extract<TraceEntry, { type: "tool" }>>();

  const onReasoningChunk = sink.onReasoningChunk;

  const wrapped: TurnSink = {
    ...sink,
    onToolStart: (label, detail, toolCallId, toolName) => {
      const entry: Extract<TraceEntry, { type: "tool" }> = {
        type: "tool",
        label,
        ...(detail === undefined ? {} : { detail }),
        ...(toolName === undefined ? {} : { name: toolName }),
      };
      entries.push(entry);
      if (toolCallId !== undefined) tools.set(toolCallId, entry);
      sink.onToolStart(label, detail, toolCallId, toolName);
    },
    onToolFinish: (toolCallId, outcome) => {
      const entry = tools.get(toolCallId);
      if (entry) entry.outcome = outcome;
      sink.onToolFinish?.(toolCallId, outcome);
    },
    onReasoningEnd: (id, failed) => {
      const entry = reasoning.get(id);
      if (entry && failed) entry.failed = true;
      sink.onReasoningEnd?.(id, failed);
    },
    onStep: (step) => {
      const pending = detectPendingConfirmation(step);
      if (pending) {
        entries.push({ type: "confirmation", id: confirmationId(pending.token), command: pending.summary, choices: pending.choices.map((c) => c.label) });
      }
      for (const login of detectLoginRequests(step)) entries.push({ type: "login", service: login.service });
      sink.onStep?.(step);
    },
  };
  if (onReasoningChunk) {
    wrapped.onReasoningChunk = (chunk, id) => {
      const entry = reasoning.get(id);
      if (entry) entry.text += chunk;
      else {
        const created: Extract<TraceEntry, { type: "reasoning" }> = { type: "reasoning", text: chunk };
        reasoning.set(id, created);
        entries.push(created);
      }
      onReasoningChunk(chunk, id);
    };
  }

  return { sink: wrapped, entries: () => entries.map((e) => ({ ...e })) };
}
