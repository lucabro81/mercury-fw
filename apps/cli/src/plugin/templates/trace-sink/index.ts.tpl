/**
 * The __TITLE__ trace sink: sends the events of what the agent does to an
 * HTTP endpoint (`__CONSTANT___URL`), as JSON lists, a batch at a time.
 * Written by `mfw plugin create` as a starting point for a sink of its own.
 * `write` never throws and never waits: it only adds the event to the batch;
 * sending happens in the background, and a batch that fails is logged and
 * dropped (traces are a record, never a reason to stop a turn). The core has
 * already cut each event to the instance's level and pseudonymised its person
 * and session.
 */
import type { TraceEvent, TraceSink, TraceSinkPlugin } from "@mercury-fw/kit";

/** How many events a batch holds before it goes. */
const BATCH = 100;

/** A sink sending batches to `url` with `fetchFn`, logging what fails with `log`. */
export function createSink(url: string, log: (msg: string) => void, fetchFn: typeof fetch = fetch): TraceSink {
  let batch: TraceEvent[] = [];
  let sending: Promise<void> = Promise.resolve();
  const send = () => {
    if (batch.length === 0) return sending;
    const events = batch;
    batch = [];
    sending = sending.then(async () => {
      try {
        const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events) });
        if (!res.ok) log(`__NAME__: ${events.length} events not sent: HTTP ${res.status}`);
      } catch (err) {
        log(`__NAME__: ${events.length} events not sent: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return sending;
  };
  return {
    write: (event) => {
      batch.push(event);
      if (batch.length >= BATCH) void send();
    },
    flush: () => send(),
  };
}

/** The sink. Declare it as `traces.sink`. */
export function __EXPORT__(): TraceSinkPlugin {
  return {
    // The contract this sink is written for, as a literal: importing
    // TRACE_SINK_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    // A sink that can't work throws: the core records no traces and starts anyway.
    build: (ctx) => {
      const url = ctx.env.__CONSTANT___URL;
      if (url === undefined || url.trim() === "") throw new Error("__CONSTANT___URL is not set");
      return createSink(url, ctx.log);
    },
  };
}
