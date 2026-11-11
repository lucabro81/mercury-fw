import { describe, expect, test } from "bun:test";
import type { TraceEvent, TraceSink } from "@mercury-fw/channel-types";
import { createTracer, noopTracer, pseudonymOf } from "./tracer.ts";

const SECRET = "a".repeat(64);
const NOW = Date.UTC(2026, 10, 11, 9, 30, 0);

/** A sink that keeps what it's given, in order. */
function collectingSink(): TraceSink & { events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return { events, write: (event) => events.push(event), flush: async () => {} };
}

describe("createTracer", () => {
  test("stamps each event with its kind and the time it happened, and keeps the ids it ties to", () => {
    const sink = collectingSink();
    const tracer = createTracer({ sink, level: "meta", secret: SECRET, now: () => NOW, log: () => {} });
    tracer.emit({ kind: "turn.start", turn: "t-1", channel: "http", opening: false });
    tracer.emit({ kind: "review.pass", job: "j-1", pass: "raw" });
    expect(sink.events).toEqual([
      { at: "2026-11-11T09:30:00.000Z", kind: "turn.start", turn: "t-1", channel: "http", opening: false },
      { at: "2026-11-11T09:30:00.000Z", kind: "review.pass", job: "j-1", pass: "raw" },
    ]);
  });

  test("never lets the person's key or the session key through: both become the same pseudonym every time", () => {
    const sink = collectingSink();
    const tracer = createTracer({ sink, level: "args", secret: SECRET, now: () => NOW, log: () => {} });
    tracer.emit({ kind: "turn.start", person: "oidc:alice@example.com", session: "oidc:alice@example.com:conv-1" });
    tracer.emit({ kind: "turn.end", person: "oidc:alice@example.com", session: "oidc:alice@example.com:conv-1" });
    const [first, second] = sink.events;
    expect(first!.person).toMatch(/^[0-9a-f]{16}$/);
    expect(first!.session).toMatch(/^[0-9a-f]{16}$/);
    expect(first!.person).not.toBe(first!.session);
    expect(second!.person).toBe(first!.person);
    expect(second!.session).toBe(first!.session);
    expect(JSON.stringify(sink.events)).not.toContain("alice");
  });

  test("a pseudonym is what pseudonymOf gives for the same secret, so an operator can find one person's events", () => {
    const sink = collectingSink();
    createTracer({ sink, level: "meta", secret: SECRET, now: () => NOW, log: () => {} }).emit({ kind: "x", person: "static:bob" });
    expect(sink.events[0]!.person).toBe(pseudonymOf(SECRET, "static:bob"));
  });

  test("another secret gives other pseudonyms", () => {
    expect(pseudonymOf(SECRET, "static:bob")).not.toBe(pseudonymOf("b".repeat(64), "static:bob"));
  });

  test("at the meta level the args are dropped whole", () => {
    const sink = collectingSink();
    const tracer = createTracer({ sink, level: "meta", secret: SECRET, now: () => NOW, log: () => {} });
    tracer.emit({ kind: "tool.call", turn: "t-1", tool: "jiraCommand", outcome: "failed", args: { input: { command: "jira issue list" }, error: "boom" } });
    expect(sink.events).toEqual([{ at: "2026-11-11T09:30:00.000Z", kind: "tool.call", turn: "t-1", tool: "jiraCommand", outcome: "failed" }]);
  });

  test("at the args level the args are kept, under args", () => {
    const sink = collectingSink();
    const tracer = createTracer({ sink, level: "args", secret: SECRET, now: () => NOW, log: () => {} });
    tracer.emit({ kind: "tool.call", tool: "jiraCommand", args: { input: { command: "jira issue list" }, error: "boom" } });
    expect(sink.events[0]).toEqual({
      at: "2026-11-11T09:30:00.000Z",
      kind: "tool.call",
      tool: "jiraCommand",
      args: { input: { command: "jira issue list" }, error: "boom" },
    });
  });

  test("an event without args has no args field at any level", () => {
    const sink = collectingSink();
    createTracer({ sink, level: "args", secret: SECRET, now: () => NOW, log: () => {} }).emit({ kind: "turn.start" });
    expect("args" in sink.events[0]!).toBe(false);
  });

  test("a sink that throws never reaches the caller, and its failure is logged once, not on every event", () => {
    const logs: string[] = [];
    const sink: TraceSink = {
      write: () => {
        throw new Error("disk full");
      },
      flush: async () => {},
    };
    const tracer = createTracer({ sink, level: "meta", secret: SECRET, now: () => NOW, log: (m) => logs.push(m) });
    expect(() => {
      tracer.emit({ kind: "a" });
      tracer.emit({ kind: "b" });
    }).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("disk full");
  });

  test("flush waits for the sink, and a sink whose flush fails resolves anyway, logged", async () => {
    const logs: string[] = [];
    let flushed = false;
    const ok = createTracer({
      sink: { write: () => {}, flush: async () => void (flushed = true) },
      level: "meta",
      secret: SECRET,
      now: () => NOW,
      log: (m) => logs.push(m),
    });
    await ok.flush();
    expect(flushed).toBe(true);

    const failing = createTracer({
      sink: {
        write: () => {},
        flush: async () => {
          throw new Error("closed");
        },
      },
      level: "meta",
      secret: SECRET,
      now: () => NOW,
      log: (m) => logs.push(m),
    });
    await failing.flush();
    expect(logs.some((m) => m.includes("closed"))).toBe(true);
  });
});

describe("noopTracer", () => {
  test("accepts every event and records nothing: an instance without traces pays nothing", async () => {
    expect(() => noopTracer.emit({ kind: "turn.start", person: "static:bob", args: { x: 1 } })).not.toThrow();
    await noopTracer.flush();
  });
});

// #23, review: the envelope belongs to the tracer, so a field an emitter writes can't replace it.
describe("createTracer: the envelope", () => {
  test("a field named at or kind in what's emitted never replaces the envelope's", () => {
    const events: TraceEvent[] = [];
    const tracer = createTracer({
      sink: { write: (e) => events.push(e), flush: async () => {} },
      level: "meta",
      secret: SECRET,
      now: () => NOW,
      log: () => {},
    });
    tracer.emit({ kind: "turn.start", at: "1999-01-01T00:00:00.000Z" } as never);
    expect(events[0]).toEqual({ at: "2026-11-11T09:30:00.000Z", kind: "turn.start" });
  });
});
