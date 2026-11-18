/**
 * The __TITLE__ sink: events go in batches on `flush` or once a batch is full,
 * a batch that fails is logged and dropped without throwing, and no sink
 * without its setting.
 */
import { describe, expect, test } from "bun:test";
import type { TraceEvent } from "@mercury-fw/kit";
import { __EXPORT__, createSink } from "./index.ts";

/** A fetch answering `status`, keeping the batches it was sent. */
function endpoint(status = 200) {
  const batches: TraceEvent[][] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    batches.push(JSON.parse(String(init?.body)) as TraceEvent[]);
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { batches, fetchFn };
}

const event = (n: number): TraceEvent => ({ at: "2026-01-01T00:00:00.000Z", kind: "turn.start", turn: `t${n}` });

describe("createSink", () => {
  test("sends what was written on flush, once", async () => {
    const { batches, fetchFn } = endpoint();
    const sink = createSink("https://traces.test", () => {}, fetchFn);
    sink.write(event(1));
    sink.write(event(2));
    await sink.flush();
    await sink.flush();
    expect(batches).toEqual([[event(1), event(2)]]);
  });

  test("sends a full batch without waiting for flush", async () => {
    const { batches, fetchFn } = endpoint();
    const sink = createSink("https://traces.test", () => {}, fetchFn);
    for (let n = 0; n < 100; n++) sink.write(event(n));
    await sink.flush();
    expect(batches.map((b) => b.length)).toEqual([100]);
  });

  test("logs a batch that fails, and drops it", async () => {
    const logs: string[] = [];
    const { fetchFn } = endpoint(503);
    const sink = createSink("https://traces.test", (line) => logs.push(line), fetchFn);
    sink.write(event(1));
    await sink.flush();
    expect(logs).toEqual(["__NAME__: 1 events not sent: HTTP 503"]);
  });
});

describe("__EXPORT__", () => {
  test("doesn't build without its setting", () => {
    expect(() => __EXPORT__().build({ env: {}, log: () => {}, dir: "/tmp" })).toThrow("__CONSTANT___URL is not set");
  });
});
