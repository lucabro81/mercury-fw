/**
 * The one place a trace event is shaped before it leaves the core: stamped
 * with when it happened, cut to the instance's trace level, and with the
 * person's key and the session key replaced by pseudonyms. Everything that
 * emits an event (the turn runner, the background jobs, the startup report)
 * goes through a `Tracer`, so a sink only ever sees what the level allows and
 * never who someone is.
 *
 * Emitting must never cost a turn anything: a sink that throws is logged once
 * and otherwise ignored. An instance that declares no sink gets `noopTracer`.
 */
import { createHmac } from "node:crypto";
import type { TraceEvent, TraceSink } from "@mercury-fw/channel-types";

/** How much an event carries: `meta` only names, outcomes, durations and sizes; `args` also what was passed in and what went wrong. */
export type TraceLevel = "meta" | "args";

/**
 * An event as the code emitting it writes it: `person` and `session` are the
 * real keys (the tracer replaces them), and `args` holds whatever is kept only
 * at the `args` level (a tool's input, an error message).
 */
export type TraceInput = {
  kind: string;
  turn?: string;
  job?: string;
  session?: string;
  person?: string;
  args?: Record<string, unknown>;
  [field: string]: unknown;
};

/** Emits events; see the module comment. */
export type Tracer = {
  emit: (input: TraceInput) => void;
  /** Resolves once the sink has stored everything emitted so far; never rejects. */
  flush: () => Promise<void>;
};

/** The pseudonym `value` (a person's key or a session key) gets under `secret`: 16 hex characters, the same every time. */
export function pseudonymOf(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 16);
}

/** A tracer that records nothing, for an instance without a trace sink. */
export const noopTracer: Tracer = { emit: () => {}, flush: async () => {} };

/** Builds the tracer writing to `sink` at `level`, with pseudonyms under `secret`. `now` is injected so tests control the time. */
export function createTracer(deps: {
  sink: TraceSink;
  level: TraceLevel;
  secret: string;
  now: () => number;
  log: (msg: string) => void;
}): Tracer {
  let failureLogged = false;

  function shape(input: TraceInput): TraceEvent {
    // `at` is the tracer's: one the emitter wrote is dropped, never kept over it.
    const { kind, person, session, args, at: _ignored, ...rest } = input;
    const event: TraceEvent = { at: new Date(deps.now()).toISOString(), kind, ...rest };
    if (session !== undefined) event.session = pseudonymOf(deps.secret, session);
    if (person !== undefined) event.person = pseudonymOf(deps.secret, person);
    if (deps.level === "args" && args !== undefined) event.args = args;
    return event;
  }

  return {
    emit: (input) => {
      try {
        deps.sink.write(shape(input));
      } catch (err) {
        if (!failureLogged) {
          failureLogged = true;
          deps.log(`[traces] the trace sink failed, events may be missing: ${String(err)}`);
        }
      }
    },
    flush: async () => {
      try {
        await deps.sink.flush();
      } catch (err) {
        deps.log(`[traces] the trace sink couldn't flush: ${String(err)}`);
      }
    },
  };
}
