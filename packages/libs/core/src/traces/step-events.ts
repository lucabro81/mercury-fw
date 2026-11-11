/**
 * What one model step of a turn becomes in the traces: a `model.step` event
 * with what Ollama measured, a `tool.call` event per tool the step called, and
 * a `confirmation.staged` event when a call was staged behind a token.
 *
 * At runtime a step is the AI SDK's full step result: besides the three fields
 * `StepInfo` names, it carries the model, the finish reason, the token usage
 * (with Ollama's own counters and durations, in nanoseconds, under
 * `usage.raw`) and how long each tool ran. The contract's `StepInfo` doesn't
 * name them, so they're read here defensively: whatever a step doesn't carry
 * (a test fake, another provider) is left out of the event, never guessed.
 */
import { detectPendingConfirmation } from "@mercury-fw/channel-types";
import { cutStrings, errorText } from "../session/call-record.ts";
import type { StepInfo } from "../session/step-info.ts";
import { classifyToolResult } from "../session/tool-start-hook.ts";
import { confirmationId } from "../session/turn-trace.ts";
import type { TraceInput } from "./tracer.ts";

/** A plain object's fields, or undefined for anything else. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `value` when it's a finite number, else undefined. */
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Nanoseconds as whole milliseconds, or undefined. */
function msOf(nanoseconds: unknown): number | undefined {
  const ns = numberOf(nanoseconds);
  return ns === undefined ? undefined : Math.round(ns / 1_000_000);
}

/** `fields` without the entries whose value is undefined. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** The `model.step` event of `step`. */
function modelStep(step: StepInfo): TraceInput {
  const runtime = step as unknown as Record<string, unknown>;
  const usage = fieldsOf(runtime.usage);
  const raw = fieldsOf(usage?.raw);
  const model = fieldsOf(runtime.model)?.modelId ?? fieldsOf(runtime.response)?.modelId;
  return {
    kind: "model.step",
    ...defined({
      step: numberOf(runtime.stepNumber),
      model: typeof model === "string" ? model : undefined,
      finishReason: typeof runtime.finishReason === "string" ? runtime.finishReason : undefined,
      inputTokens: numberOf(usage?.inputTokens),
      outputTokens: numberOf(usage?.outputTokens),
      loadMs: msOf(raw?.load_duration),
      prefillMs: msOf(raw?.prompt_eval_duration),
      generationMs: msOf(raw?.eval_duration),
      totalMs: msOf(raw?.total_duration),
    }),
    toolCalls: step.toolCalls.length,
  };
}

/** The `tool.call` event of `call`, one of `step`'s calls. */
function toolCall(call: StepInfo["toolCalls"][number], step: StepInfo): TraceInput {
  const runtime = step as unknown as Record<string, unknown>;
  const executionMs = numberOf(fieldsOf(fieldsOf(runtime.performance)?.toolExecutionMs)?.[call.toolCallId]);
  const durationMs = executionMs === undefined ? undefined : Math.round(executionMs);
  const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
  const input = cutStrings(call.input);
  if (result === undefined) {
    const failure = step.content.find((part) => part.type === "tool-error" && part.toolCallId === call.toolCallId);
    return {
      kind: "tool.call",
      tool: call.toolName,
      outcome: "failed",
      ...defined({ durationMs }),
      args: defined({ input, error: failure === undefined ? undefined : errorText(failure.error) }),
    };
  }
  const outcome = classifyToolResult(result.output);
  const error = outcome === "failed" ? fieldsOf(result.output)?.error : undefined;
  return {
    kind: "tool.call",
    tool: call.toolName,
    outcome,
    ...defined({
      durationMs,
      resultChars: (JSON.stringify(result.output) ?? "").length,
    }),
    args: defined({ input, error: error === undefined ? undefined : errorText(error) }),
  };
}

/** The events of one finished model step, in order: the step, its tool calls, a staged confirmation. */
export function stepEvents(step: StepInfo): TraceInput[] {
  const events = [modelStep(step), ...step.toolCalls.map((call) => toolCall(call, step))];
  const pending = detectPendingConfirmation(step);
  if (pending !== null) {
    events.push({
      kind: "confirmation.staged",
      confirmationId: confirmationId(pending.token),
      choices: pending.choices.length,
      args: { summary: pending.summary },
    });
  }
  return events;
}
