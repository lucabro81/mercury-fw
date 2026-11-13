import { describe, expect, it } from "bun:test";
import { captureToMemory, createSessionBuffers, type CaptureDeps } from "./capture.ts";
import type { Message } from "./messages.ts";

const NOW = new Date("2026-11-13T10:00:00.000Z");
const msgs = (n: number): Message[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));

/** Capture deps recording what was kept, failing where asked. */
function deps(opts: { summarizeFails?: boolean; extractFails?: boolean; promote?: boolean } = {}) {
  const kept: unknown[] = [];
  const logs: string[] = [];
  const d: CaptureDeps = {
    summarize: async (m) => {
      if (opts.summarizeFails) throw new Error("model down");
      return `summary of ${m.length}`;
    },
    storeSummary: async (e) => void kept.push(["summary", e]),
    extractFacts: async () => {
      if (opts.extractFails) throw new Error("bad json");
      return [{ topic: "team", value: "platform" }];
    },
    storeFact: async (e) => void kept.push(["fact", e]),
    ...(opts.promote ? { promoteFact: async (userId: string, topic: string) => (kept.push(["promote", userId, topic]), "written" as const) } : {}),
    log: (m) => void logs.push(m),
    now: () => NOW,
  };
  return { d, kept, logs };
}

describe("captureToMemory (#393)", () => {
  it("keeps the summary and each fact under one timestamp, and promotes the fact through the wiki", async () => {
    const { d, kept, logs } = deps({ promote: true });
    await captureToMemory("static:alice", "s1", msgs(2), d);
    const at = NOW.toISOString();
    expect(kept).toEqual([
      ["summary", { userId: "static:alice", sessionKey: "s1", summary: "summary of 2", timestamp: at }],
      ["fact", { userId: "static:alice", topic: "team", value: "platform", timestamp: at }],
      ["promote", "static:alice", "team"],
    ]);
    expect(logs).toEqual(["[memory] fact team for s1: written"]);
  });

  it("keeps the facts in the index alone without a wiki", async () => {
    const { d, kept } = deps();
    await captureToMemory("static:alice", "s1", msgs(2), d);
    expect(kept.map((k) => (k as unknown[])[0])).toEqual(["summary", "fact"]);
  });

  it("fails when the summary can't be made, keeping nothing", async () => {
    const { d, kept } = deps({ summarizeFails: true });
    await expect(captureToMemory("static:alice", "s1", msgs(2), d)).rejects.toThrow("model down");
    expect(kept).toEqual([]);
  });

  // The facts are enrichment on top of the summary: their failure never undoes it.
  it("keeps the summary when the facts can't be extracted, and logs it", async () => {
    const { d, kept, logs } = deps({ extractFails: true });
    await captureToMemory("static:alice", "s1", msgs(2), d);
    expect(kept.map((k) => (k as unknown[])[0])).toEqual(["summary"]);
    expect(logs).toEqual(["[memory] facts not extracted for s1: bad json"]);
  });
});

describe("createSessionBuffers (#393)", () => {
  function setUp(fail = false) {
    const captured: Array<[string, string, number]> = [];
    const logs: string[] = [];
    const buffers = createSessionBuffers({
      threshold: 4,
      capture: async (person, session, messages) => {
        if (fail) throw new Error("index down");
        captured.push([person, session, messages.length]);
      },
      job: (fn) => fn(),
      log: (m) => void logs.push(m),
    });
    return { buffers, captured, logs };
  }

  it("captures a person's messages of a session once there are as many as the threshold, then starts over", async () => {
    const { buffers, captured } = setUp();
    await buffers.add("s1", "static:alice", msgs(2));
    expect(captured).toEqual([]);
    await buffers.add("s1", "static:alice", msgs(2));
    await buffers.add("s1", "static:alice", msgs(2));
    expect(captured).toEqual([["static:alice", "s1", 4]]);
  });

  it("keeps each person's messages apart, in a shared session too", async () => {
    const { buffers, captured } = setUp();
    await buffers.add("s1", "static:alice", msgs(2));
    await buffers.add("s1", "static:bob", msgs(2));
    expect(captured).toEqual([]);
    await buffers.close("s1");
    expect(captured.sort()).toEqual([
      ["static:alice", "s1", 2],
      ["static:bob", "s1", 2],
    ]);
  });

  it("captures what's left when the session closes, and forgets it", async () => {
    const { buffers, captured } = setUp();
    await buffers.add("s1", "static:alice", msgs(4));
    await buffers.add("s1", "static:alice", msgs(2));
    await buffers.close("s1");
    await buffers.close("s1");
    expect(captured).toEqual([
      ["static:alice", "s1", 4],
      ["static:alice", "s1", 2],
    ]);
  });

  it("keeps the messages of a capture that failed for the next one, and logs it", async () => {
    const { buffers, logs } = setUp(true);
    await buffers.add("s1", "static:alice", msgs(4));
    expect(logs).toEqual(["[memory] capture of s1 failed, kept for the next one: index down"]);
    expect(buffers.pending("s1", "static:alice")).toBe(4);
  });

  // Review of #393: close found the buffer capturing and returned; what came
  // after that capture started was never captured, and a failure lost it all.
  it("on close, waits for a capture already running, then captures what came after it", async () => {
    const captured: number[] = [];
    let release!: () => void;
    let first = true;
    const buffers = createSessionBuffers({
      threshold: 2,
      capture: async (_person, _session, messages) => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        captured.push(messages.length);
      },
      job: (fn) => fn(),
      log: () => {},
    });
    const running = buffers.add("s1", "static:alice", msgs(2));
    await buffers.add("s1", "static:alice", msgs(1));
    const closing = buffers.close("s1");
    release();
    await running;
    await closing;
    expect(captured).toEqual([2, 1]);
  });

  it("drops what a capture on close couldn't keep, after one try, and logs it", async () => {
    const { buffers, logs } = setUp(true);
    await buffers.add("s1", "static:alice", msgs(2));
    await buffers.close("s1");
    expect(logs).toEqual(["[memory] capture of s1 failed, its messages are dropped: index down"]);
    expect(buffers.pending("s1", "static:alice")).toBe(0);
  });
});
