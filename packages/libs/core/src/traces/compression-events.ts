/**
 * The `history.compressed` event: a conversation folding its older messages
 * into something shorter happens inside a turn, often on the model, and costs
 * the person waiting for the answer. The plugin keeping the conversation
 * reports each compression (`CompressionReport`); this is the event the core
 * records for it, so the tracer still cuts and pseudonymises it as any other.
 */
import type { CompressionReport } from "@mercury-fw/plugin-types";
import type { TraceInput } from "./tracer.ts";

/** The `history.compressed` event for `report`: its error, when it failed, under `args`. */
export function compressionEvent(report: CompressionReport): TraceInput {
  const { error, ...rest } = report;
  return { kind: "history.compressed", ...rest, ...(error === undefined ? {} : { args: { error } }) };
}
