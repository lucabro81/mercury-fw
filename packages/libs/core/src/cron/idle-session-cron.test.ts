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
        return [{ topic: "preferred-language", value: "italiano" }];
      },
      storeFact: async (entry) => {
        storedFacts.push(entry);
      },
      consolidateFact: async (userId, topic) => {
        consolidatedTopics.push([userId, topic]);
      },
    });

    expect(storedFacts).toEqual([
      { userId: "users/1", topic: "preferred-language", value: "italiano", timestamp: new Date(NOW).toISOString() },
    ]);
    expect(consolidatedTopics).toEqual([["users/1", "preferred-language"]]);
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

  // Hard-won convention (CLAUDE.md): one bad tick must never take down the
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
        return [{ topic: "preferred-language", value: "italiano" }];
      },
      storeFact: async (entry) => {
        storedFacts.push(entry);
      },
      consolidateFact: async (userId, topic) => {
        consolidatedTopics.push([userId, topic]);
      },
    });

    expect(storedFacts).toEqual([
      { userId: "users/1", topic: "preferred-language", value: "italiano", timestamp: new Date(NOW).toISOString() },
    ]);
    expect(consolidatedTopics).toEqual([["users/1", "preferred-language"]]);
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

describe("runIdleSessionSweep under a session lock", () => {
  it("captures and closes each session inside withSession", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    const events: string[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      withSession: async (key, fn) => {
        events.push(`lock:${key}`);
        await fn();
        events.push(`unlock:${key}`);
      },
      getSession: (key) => ({ key, userId: "u1", messages: [{ role: "user", content: "hi" }] }),
      summarize: async () => {
        events.push("summarize");
        return "s";
      },
      store: async () => {},
      closeSession: () => events.push("close"),
    });

    expect(events).toEqual(["lock:s1", "summarize", "close", "unlock:s1"]);
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
