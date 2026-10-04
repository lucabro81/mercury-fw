/**
 * Bounded, process-wide history of tool calls across both channels,
 * scoped by session so a recall of "what did you do" only ever surfaces
 * one conversation's own history, and by person (the user key) so the HTTP
 * surface shows each caller only their own calls. It backs the
 * `recall_tool_calls` model tool (`tool-log-recall-tool.ts`) and the HTTP
 * `/tool-log` route: the record of what happened in a session. Nothing else keeps
 * this beyond the current turn (`src/index.ts`'s terminal-only `lastSteps`
 * resets every turn, Google Chat's `onStepFinish` only logs to stderr) —
 * `recordStep` is called additively from both channels' existing
 * `onStepFinish` wiring, changing neither channel's own behavior.
 */
import { truncateForDisplay } from "../router/tool-log.ts";
import type { StepInfo } from "./step-info.ts";

/**
 * Whatever the provider that ran the turn calls itself — see
 * `InboundTurn.channel` in `src/router/provider.ts`. Was a closed union
 * ("terminal" | "google-chat") back when the set of providers was fixed in
 * this file; widened so a new provider is a new `Provider` implementation,
 * not an edit here.
 */
export type ToolLogChannel = string;

export type ToolLogEntry = {
  timestamp: string;
  channel: ToolLogChannel;
  sessionKey: string;
  /** The user key of the person whose turn made the call. */
  owner: string;
  toolName: string;
  input: string;
  output: string;
};

const MAX_ENTRIES = 200;
const MAX_CHARS = 2000;

let buffer: ToolLogEntry[] = [];

/** Records every tool call in `step`, made in `sessionKey` during a turn of the person `owner`. */
export function recordStep(channel: ToolLogChannel, sessionKey: string, owner: string, step: StepInfo): void {
  for (const call of step.toolCalls) {
    const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
    const errorPart = step.content.find((p) => p.type === "tool-error" && p.toolCallId === call.toolCallId);
    const output = result
      ? truncateForDisplay(result.output, MAX_CHARS)
      : errorPart
        ? `[error] ${truncateForDisplay(errorPart.error, MAX_CHARS)}`
        : "(none)";

    buffer.push({
      timestamp: new Date().toISOString(),
      channel,
      sessionKey,
      owner,
      toolName: call.toolName,
      input: truncateForDisplay(call.input, MAX_CHARS),
      output,
    });
    if (buffer.length > MAX_ENTRIES) {
      buffer.shift();
    }
  }
}

/** Most recent entries first, optionally restricted to one session and/or one person. */
export function getToolLog(filter?: { sessionKey?: string; owner?: string }): ToolLogEntry[] {
  const matching = buffer.filter(
    (e) =>
      (filter?.sessionKey === undefined || e.sessionKey === filter.sessionKey) &&
      (filter?.owner === undefined || e.owner === filter.owner),
  );
  return [...matching].reverse();
}

/** Test-only: clears the module-level buffer so tests don't leak into each other. */
export function resetToolLogForTest(): void {
  buffer = [];
}
