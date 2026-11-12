import { describe, it, expect } from "bun:test";
import { createIdleSessionScanner } from "./idle-session-scanner.ts";
import { runIdleSessionSweep, startIdleSessionCron, captureSessionToMemory } from "./idle-session-cron.ts";
import type { Message } from "../session/history.ts";
import type { EpisodicSummary } from "../memory/episodic-store.ts";
import type { SemanticFactEntry } from "../memory/semantic-facts-store.ts";

const NOW = 1_000_000_000;
const TIMEOUT = 30 * 60_000;

describe("captureSessionToMemory", () => {
  // Regression guard for the model-invented-date bug (see
  // episodic-summarizer.ts): the summary text is stored exactly as
  // produced, verbatim — the entry's own `timestamp` field is the one and
  // only source of truth for "when", never duplicated into the text.
  it("summarizes and stores an episodic entry verbatim, without touching the summary text", async () => {
    let stored: EpisodicSummary | undefined;
    const messages: Message[] = [{ role: "user", content: "hi" }];

    await captureSessionToMemory("users/1", "spaces/X:users/1", messages, NOW, {
      summarize: async (msgs) => {
        expect(msgs).toBe(messages);
        return "user said hi";
      },
      store: async (entry) => {
        stored = entry;
      },
    });

    expect(stored).toEqual({
      userId: "users/1",
      sessionKey: "spaces/X:users/1",
      summary: "user said hi",
      timestamp: new Date(NOW).toISOString(),
    });
  });

  it("lets a summarize/store failure propagate to the caller", async () => {
    await expect(
      captureSessionToMemory("users/1", "k", [], NOW, {
        summarize: async () => "ok",
        store: async () => {
          throw new Error("qdrant unreachable");
        },
      }),
    ).rejects.toThrow("qdrant unreachable");
  });

  it("extracts and consolidates semantic facts after a successful store, when semantic deps are provided", async () => {
    const messages: Message[] = [{ role: "user", content: "preferisco l'italiano" }];
    const storedFacts: SemanticFactEntry[] = [];
    const consolidatedTopics: Array<[string, string]> = [];

    await captureSessionToMemory("users/1", "k", messages, NOW, {
      summarize: async () => "ok",
      store: async () => {},
      extractFacts: async (msgs) => {
        expect(msgs).toBe(messages);
        return [{ topic: "role", value: "developer" }];
      },
      storeFact: async (entry) => {
        storedFacts.push(entry);
      },
      consolidateFact: async (userId, topic) => {
        consolidatedTopics.push([userId, topic]);
      },
    });

    expect(storedFacts).toEqual([
      { userId: "users/1", topic: "role", value: "developer", timestamp: new Date(NOW).toISOString() },
    ]);
    expect(consolidatedTopics).toEqual([["users/1", "role"]]);
  });

  it("a failure extracting semantic facts is caught and logged, doesn't throw", async () => {
    const loggedMessages: string[] = [];

    await captureSessionToMemory("users/1", "k", [], NOW, {
      summarize: async () => "ok",
      store: async () => {},
      extractFacts: async () => {
        throw new Error("model unreachable");
      },
      storeFact: async () => {},
      consolidateFact: async () => {},
      log: (msg) => loggedMessages.push(msg),
    });

    expect(loggedMessages.some((m) => m.includes("model unreachable"))).toBe(true);
  });

  it("a failure storing/consolidating one fact doesn't stop the others", async () => {
    const consolidatedTopics: string[] = [];
    const loggedMessages: string[] = [];

    await captureSessionToMemory("users/1", "k", [], NOW, {
      summarize: async () => "ok",
      store: async () => {},
      extractFacts: async () => [
        { topic: "team", value: "x" },
        { topic: "role", value: "y" },
      ],
      storeFact: async (entry) => {
        if (entry.topic === "team") {
          throw new Error("qdrant unreachable");
        }
      },
      consolidateFact: async (_userId, topic) => {
        consolidatedTopics.push(topic);
      },
      log: (msg) => loggedMessages.push(msg),
    });

    expect(consolidatedTopics).toEqual(["role"]);
    expect(loggedMessages.some((m) => m.includes("team") && m.includes("qdrant unreachable"))).toBe(true);
  });
});

describe("runIdleSessionSweep", () => {
  it("summarizes, stores, and closes each idle session, then clears it from the scanner", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", NOW - TIMEOUT);

    const messages: Message[] = [{ role: "user", content: "hi" }];
    let storedEntry: EpisodicSummary | undefined;
    let closedKey: string | undefined;

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "users/1", messages }),
      summarize: async (msgs) => {
        expect(msgs).toBe(messages);
        return "user said hi";
      },
      store: async (entry) => {
        storedEntry = entry;
      },
      closeSession: (key) => {
        closedKey = key;
      },
    });

    expect(storedEntry).toEqual({
      userId: "users/1",
      sessionKey: "spaces/X:users/1",
      summary: "user said hi",
      timestamp: new Date(NOW).toISOString(),
    });
    expect(closedKey).toBe("spaces/X:users/1");
    expect(scanner.scanIdle(NOW, TIMEOUT)).toEqual([]);
  });

  it("does nothing for sessions that aren't idle yet", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", NOW - TIMEOUT + 60_000); // 1 min short of the timeout

    let summarizeCalls = 0;
    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: () => ({ key: "spaces/X:users/1", userId: "users/1", messages: [] }),
      summarize: async () => {
        summarizeCalls++;
        return "";
      },
      store: async () => {},
      closeSession: () => {},
    });

    expect(summarizeCalls).toBe(0);
  });

  it("clears tracking without summarizing/storing when the session no longer exists", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("gone", NOW - TIMEOUT);

    let summarizeCalls = 0;
    let storeCalls = 0;
    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: () => undefined,
      summarize: async () => {
        summarizeCalls++;
        return "";
      },
      store: async () => {
        storeCalls++;
      },
      closeSession: () => {},
    });

    expect(summarizeCalls).toBe(0);
    expect(storeCalls).toBe(0);
    expect(scanner.scanIdle(NOW, TIMEOUT)).toEqual([]);
  });

  // Hard-won convention (AGENTS.md): one bad tick must never take down the
  // rest of Mercury. A failure summarizing/storing one idle session must
  // not stop other idle sessions in the same sweep from being processed,
  // and must not silently clear the failed session's tracking (so it's
  // retried on the next sweep instead of being lost).
  it("a failure for one session doesn't stop the sweep from processing the others, and leaves the failed one tracked for retry", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("bad", NOW - TIMEOUT);
    scanner.touch("good", NOW - TIMEOUT);

    const closedKeys: string[] = [];
    const loggedMessages: string[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "users/1", messages: [] }),
      summarize: async (_msgs) => {
        return "ok";
      },
      store: async (entry) => {
        if (entry.sessionKey === "bad") {
          throw new Error("qdrant unreachable");
        }
      },
      closeSession: (key) => {
        closedKeys.push(key);
      },
      log: (msg) => loggedMessages.push(msg),
    });

    expect(closedKeys).toEqual(["good"]);
    expect(scanner.scanIdle(NOW, TIMEOUT)).toEqual(["bad"]); // still tracked, will retry
    expect(loggedMessages.some((m) => m.includes("bad") && m.includes("qdrant unreachable"))).toBe(true);
  });

  // Semantic fact extraction/consolidation is an enrichment layered on top
  // of the episodic summary, not a required part of it — every existing
  // test above omits these deps entirely and still passes, since the
  // sweep must keep working when they're absent (same Layer-boundary
  // principle as episodic memory itself: optional, not load-bearing).
  it("extracts and consolidates semantic facts for the session after a successful summarize+store, when semantic deps are provided", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", NOW - TIMEOUT);
    const messages: Message[] = [{ role: "user", content: "preferisco l'italiano" }];

    const storedFacts: SemanticFactEntry[] = [];
    const consolidatedTopics: Array<[string, string]> = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "users/1", messages }),
      summarize: async () => "ok",
      store: async () => {},
      closeSession: () => {},
      extractFacts: async (msgs) => {
        expect(msgs).toBe(messages);
        return [{ topic: "role", value: "developer" }];
      },
      storeFact: async (entry) => {
        storedFacts.push(entry);
      },
      consolidateFact: async (userId, topic) => {
        consolidatedTopics.push([userId, topic]);
      },
    });

    expect(storedFacts).toEqual([
      { userId: "users/1", topic: "role", value: "developer", timestamp: new Date(NOW).toISOString() },
    ]);
    expect(consolidatedTopics).toEqual([["users/1", "role"]]);
  });

  it("a failure extracting semantic facts doesn't prevent the session from closing, just logs it", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", NOW - TIMEOUT);

    let closedKey: string | undefined;
    const loggedMessages: string[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "users/1", messages: [] }),
      summarize: async () => "ok",
      store: async () => {},
      closeSession: (key) => {
        closedKey = key;
      },
      extractFacts: async () => {
        throw new Error("model unreachable");
      },
      storeFact: async () => {},
      consolidateFact: async () => {},
      log: (msg) => loggedMessages.push(msg),
    });

    expect(closedKey).toBe("spaces/X:users/1");
    expect(loggedMessages.some((m) => m.includes("model unreachable"))).toBe(true);
  });

  it("a failure storing/consolidating one fact doesn't stop the others from being processed", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", NOW - TIMEOUT);

    const consolidatedTopics: string[] = [];
    const loggedMessages: string[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "users/1", messages: [] }),
      summarize: async () => "ok",
      store: async () => {},
      closeSession: () => {},
      extractFacts: async () => [
        { topic: "team", value: "x" },
        { topic: "role", value: "y" },
      ],
      storeFact: async (entry) => {
        if (entry.topic === "team") {
          throw new Error("qdrant unreachable");
        }
      },
      consolidateFact: async (_userId, topic) => {
        consolidatedTopics.push(topic);
      },
      log: (msg) => loggedMessages.push(msg),
    });

    expect(consolidatedTopics).toEqual(["role"]);
    expect(loggedMessages.some((m) => m.includes("team") && m.includes("qdrant unreachable"))).toBe(true);
  });
});

// #379: an instance without a vector index keeps no memory: an idle session
// is closed without a summary (no call to the model) and without storing it.
describe("runIdleSessionSweep without memory", () => {
  it("closes and clears an idle session without summarizing or storing it", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", NOW - TIMEOUT);
    const called: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      capture: false,
      getSession: (key) => ({ key, userId: "users/1", messages: [{ role: "user", content: "hi" }] }),
      summarize: async () => (called.push("summarize"), "x"),
      store: async () => void called.push("store"),
      closeSession: (key) => void called.push(`close ${key}`),
      emit: (event) => void events.push(event as Record<string, unknown>),
    });

    expect(called).toEqual(["close spaces/X:users/1"]);
    expect(scanner.scanIdle(NOW, TIMEOUT)).toEqual([]);
    expect(events).toEqual([{ kind: "session.closed", session: "spaces/X:users/1", person: "users/1", messages: 1 }]);
  });
});

describe("runIdleSessionSweep under a session lock", () => {
  // #383: the capture is background work queued for the model. Inside the
  // lock it would hold the session's next turn behind it (and, with that
  // turn counted on the model, never run): the sweep takes the session's
  // messages under the lock, captures outside it, and closes it under the
  // lock again.
  it("takes the messages and closes the session under withSession, capturing in between outside it, as a job", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    const events: string[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      withSession: async (key, fn) => {
        events.push(`lock:${key}`);
        await fn();
        events.push(`unlock:${key}`);
      },
      job: async (fn) => {
        events.push("job start");
        const result = await fn();
        events.push("job end");
        return result;
      },
      getSession: (key) => ({ key, userId: "u1", messages: [{ role: "user", content: "hi" }] }),
      summarize: async () => {
        events.push("summarize");
        return "s";
      },
      store: async () => {},
      closeSession: () => events.push("close"),
    });

    expect(events).toEqual(["lock:s1", "unlock:s1", "job start", "summarize", "job end", "lock:s1", "close", "unlock:s1"]);
  });

  it("a turn that ran while the capture did keeps the session open, still tracked", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    let closed = false;

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "u1", messages: [{ role: "user", content: "hi" }] }),
      summarize: async () => {
        scanner.touch("s1", NOW + 1); // a turn of the session ran meanwhile
        return "s";
      },
      store: async () => {},
      closeSession: () => {
        closed = true;
      },
    });

    expect(closed).toBe(false);
    expect(scanner.isIdle("s1", NOW + 1 + TIMEOUT, TIMEOUT)).toBe(true);
  });

  // Regression for #154: the sweep captured a session and closed it after an
  // await, so a turn that ran meanwhile lost its history. A session touched
  // by the time the sweep holds it is no longer idle and stays open.
  it("skips a session that was touched while the sweep waited for it", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    let summarizeCalls = 0;
    let closed = false;

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      withSession: async (_key, fn) => {
        scanner.touch("s1", NOW + 1); // a turn ran before the sweep got the session
        await fn();
      },
      getSession: (key) => ({ key, userId: "u1", messages: [] }),
      summarize: async () => {
        summarizeCalls++;
        return "s";
      },
      store: async () => {},
      closeSession: () => {
        closed = true;
      },
    });

    expect(summarizeCalls).toBe(0);
    expect(closed).toBe(false);
    expect(scanner.isIdle("s1", NOW + 1 + TIMEOUT, TIMEOUT)).toBe(true);
  });
});

describe("startIdleSessionCron", () => {
  it("runs a sweep on each tick and stop() halts further ticks", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", 0);
    // Re-touches independently of the sweep's own clear-after-close (a
    // re-touch from inside closeSession would just be wiped out by the
    // scanner.clear(key) that runs right after it in the same sweep
    // iteration) — purely so this fixture stays "idle" across multiple
    // real ticks, letting the test observe more than one.
    const retoucher = setInterval(() => scanner.touch("spaces/X:users/1", 0), 5);

    let sweeps = 0;
    const cron = startIdleSessionCron(
      scanner,
      {
        getSession: () => ({ key: "spaces/X:users/1", userId: "users/1", messages: [] }),
        summarize: async () => {
          sweeps++;
          return "s";
        },
        store: async () => {},
        closeSession: () => {},
      },
      { idleTimeoutMs: 0, checkIntervalMs: 10 },
    );

    await new Promise((r) => setTimeout(r, 45));
    cron.stop();
    clearInterval(retoucher);
    const sweepsAtStop = sweeps;
    await new Promise((r) => setTimeout(r, 30));

    expect(sweepsAtStop).toBeGreaterThan(1);
    expect(sweeps).toBe(sweepsAtStop); // no further ticks after stop
  });

  // Regression for #154: a sweep slower than the check interval overlapped
  // the next one, and both captured the same idle session.
  it("never starts a sweep while the previous one is still running", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", 0);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let summarizeCalls = 0;

    const cron = startIdleSessionCron(
      scanner,
      {
        getSession: (key) => ({ key, userId: "u1", messages: [] }),
        summarize: async () => {
          summarizeCalls++;
          await hold;
          return "s";
        },
        store: async () => {},
        closeSession: () => {},
      },
      { idleTimeoutMs: 0, checkIntervalMs: 5 },
    );

    await new Promise((r) => setTimeout(r, 40));
    cron.stop();
    release();
    expect(summarizeCalls).toBe(1);
  });
});

// #23: every capture, what consolidation decided and every closed session reach the traces.
describe("memory events", () => {
  type Emitted = Record<string, unknown>;
  const messages: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];

  it("a capture says what triggered it, how many messages and facts, how long it took; each fact says what consolidation decided", async () => {
    const events: Emitted[] = [];
    let clock = 0;
    await captureSessionToMemory(
      "static:alice",
      "sk",
      messages,
      NOW,
      {
        summarize: async () => {
          clock += 900;
          return "ok";
        },
        store: async () => {},
        extractFacts: async () => [
          { topic: "role", value: "developer" },
          { topic: "team", value: "platform" },
        ],
        storeFact: async () => {},
        consolidateFact: async (_u, topic) => (topic === "role" ? "written" : "kept-incumbent"),
        emit: (e) => void events.push(e),
        clock: () => clock,
      },
      "threshold",
    );
    expect(events).toEqual([
      { kind: "memory.consolidate", session: "sk", person: "static:alice", subject: "fact", topic: "role", decision: "written" },
      { kind: "memory.consolidate", session: "sk", person: "static:alice", subject: "fact", topic: "team", decision: "kept-incumbent" },
      { kind: "memory.capture", session: "sk", person: "static:alice", trigger: "threshold", messages: 2, facts: 2, durationMs: 900, outcome: "done" },
    ]);
  });

  it("a capture that fails says so, with the error for the args level, and the failure still reaches the caller", async () => {
    const events: Emitted[] = [];
    await expect(
      captureSessionToMemory(
        "static:alice",
        "sk",
        messages,
        NOW,
        {
          summarize: async () => "ok",
          store: async () => {
            throw new Error("qdrant unreachable");
          },
          emit: (e) => void events.push(e),
          clock: () => 0,
        },
        "compress",
      ),
    ).rejects.toThrow("qdrant unreachable");
    expect(events).toEqual([
      { kind: "memory.capture", session: "sk", person: "static:alice", trigger: "compress", messages: 2, durationMs: 0, outcome: "failed", args: { error: "qdrant unreachable" } },
    ]);
  });

  it("a fact whose consolidation throws is a failed decision, the others go on", async () => {
    const events: Emitted[] = [];
    await captureSessionToMemory("p", "sk", messages, NOW, {
      summarize: async () => "ok",
      store: async () => {},
      extractFacts: async () => [{ topic: "role", value: "x" }],
      storeFact: async () => {},
      consolidateFact: async () => {
        throw new Error("vault locked");
      },
      emit: (e) => void events.push(e),
      log: () => {},
      clock: () => 0,
    });
    expect(events[0]).toEqual({ kind: "memory.consolidate", session: "sk", person: "p", subject: "fact", topic: "role", decision: "failed", args: { error: "vault locked" } });
    expect(events[1]).toMatchObject({ kind: "memory.capture", trigger: "idle", outcome: "done" });
  });

  it("the idle sweep closes a session after its capture, and says so", async () => {
    const events: Emitted[] = [];
    const scanner = createIdleSessionScanner();
    scanner.touch("sk", NOW - TIMEOUT - 1);
    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: () => ({ key: "sk", userId: "p", messages }),
      closeSession: () => {},
      summarize: async () => "ok",
      store: async () => {},
      emit: (e) => void events.push(e),
      clock: () => 0,
    });
    expect(events.map((e) => [e.kind, e.trigger ?? null])).toEqual([
      ["memory.capture", "idle"],
      ["session.closed", null],
    ]);
    expect(events[1]).toEqual({ kind: "session.closed", session: "sk", person: "p", messages: 2 });
  });
});

// #23, review: a failed fact extraction must be told apart from extraction not being configured.
describe("memory events: a failed extraction", () => {
  it("the capture is still done, and says the extraction failed, with the error for args", async () => {
    const events: Array<Record<string, unknown>> = [];
    await captureSessionToMemory("p", "sk", [{ role: "user", content: "hi" }], NOW, {
      summarize: async () => "ok",
      store: async () => {},
      extractFacts: async () => {
        throw new Error("model down");
      },
      storeFact: async () => {},
      consolidateFact: async () => "written",
      emit: (e) => void events.push(e),
      log: () => {},
      clock: () => 0,
    });
    expect(events).toEqual([
      { kind: "memory.capture", session: "sk", person: "p", trigger: "idle", messages: 1, extraction: "failed", durationMs: 0, outcome: "done", args: { error: "model down" } },
    ]);
  });
});

describe("runIdleSessionSweep: onClosed (#387)", () => {
  it("tells onClosed about a session once it's closed, with the messages it was closed with, outside the lock", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    const events: string[] = [];
    const told: unknown[] = [];
    const messages: Message[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      capture: false,
      withSession: async (_key, fn) => {
        events.push("lock");
        await fn();
        events.push("unlock");
      },
      getSession: (key) => ({ key, userId: "u1", messages }),
      summarize: async () => "s",
      store: async () => {},
      closeSession: () => events.push("close"),
      onClosed: (session) => {
        events.push("onClosed");
        told.push(session);
      },
    });

    expect(events).toEqual(["lock", "unlock", "lock", "close", "unlock", "onClosed"]);
    expect(told).toEqual([{ key: "s1", userId: "u1", messages }]);
  });

  it("a session a turn kept open isn't closed, so onClosed hears nothing", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    const told: unknown[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "u1", messages: [] }),
      summarize: async () => {
        scanner.touch("s1", NOW + 1);
        return "s";
      },
      store: async () => {},
      closeSession: () => {},
      onClosed: (session) => void told.push(session),
    });

    expect(told).toEqual([]);
  });

  it("an onClosed that throws doesn't stop the sweep from closing the next session", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    scanner.touch("s2", NOW - TIMEOUT);
    const closed: string[] = [];
    const logs: string[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      capture: false,
      getSession: (key) => ({ key, userId: "u1", messages: [] }),
      summarize: async () => "s",
      store: async () => {},
      closeSession: (key) => void closed.push(key),
      onClosed: () => {
        throw new Error("hook broke");
      },
      log: (msg) => void logs.push(msg),
    });

    expect(closed).toEqual(["s1", "s2"]);
    expect(scanner.scanIdle(NOW, TIMEOUT)).toEqual([]);
    expect(logs.some((l) => l.includes("hook broke"))).toBe(true);
  });
});
