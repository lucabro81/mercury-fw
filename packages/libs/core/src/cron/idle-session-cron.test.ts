import { describe, it, expect } from "bun:test";
import { createIdleSessionScanner } from "./idle-session-scanner.ts";
import { runIdleSessionSweep, startIdleSessionCron } from "./idle-session-cron.ts";
import type { Message } from "../session/history.ts";

const NOW = 1_000_000_000;
const TIMEOUT = 30 * 60_000;

describe("runIdleSessionSweep", () => {
  it("closes each idle session and clears it from the scanner, saying so", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", NOW - TIMEOUT);
    const closed: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "users/1", messages: [{ role: "user", content: "hi" }] }),
      closeSession: (key) => void closed.push(key),
      emit: (event) => void events.push(event as Record<string, unknown>),
    });

    expect(closed).toEqual(["spaces/X:users/1"]);
    expect(scanner.scanIdle(NOW, TIMEOUT)).toEqual([]);
    expect(events).toEqual([{ kind: "session.closed", session: "spaces/X:users/1", person: "users/1", messages: 1 }]);
  });

  it("does nothing for sessions that aren't idle yet", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - 1000);
    const closed: string[] = [];
    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "u1", messages: [] }),
      closeSession: (key) => void closed.push(key),
    });
    expect(closed).toEqual([]);
  });

  it("clears tracking without closing anything when the session no longer exists", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    const closed: string[] = [];
    await runIdleSessionSweep(scanner, NOW, TIMEOUT, { getSession: () => undefined, closeSession: (key) => void closed.push(key) });
    expect(closed).toEqual([]);
    expect(scanner.scanIdle(NOW, TIMEOUT)).toEqual([]);
  });

  it("a failure for one session doesn't stop the sweep from processing the others", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    scanner.touch("s2", NOW - TIMEOUT);
    const closed: string[] = [];
    const logs: string[] = [];
    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "u1", messages: [] }),
      closeSession: (key) => {
        if (key === "s1") throw new Error("boom");
        closed.push(key);
      },
      log: (msg) => void logs.push(msg),
    });
    expect(closed).toEqual(["s2"]);
    expect(logs).toEqual(["idle session sweep failed for s1: Error: boom"]);
  });

  // Regression for #154: a session touched by the time the sweep holds it is no longer idle and stays open.
  it("skips a session that was touched while the sweep waited for it", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    let closed = false;
    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      withSession: async (_key, fn) => {
        scanner.touch("s1", NOW + 1); // a turn ran before the sweep got the session
        await fn();
      },
      getSession: (key) => ({ key, userId: "u1", messages: [] }),
      closeSession: () => {
        closed = true;
      },
    });
    expect(closed).toBe(false);
    expect(scanner.isIdle("s1", NOW + 1 + TIMEOUT, TIMEOUT)).toBe(true);
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
      withSession: async (_key, fn) => {
        events.push("lock");
        await fn();
        events.push("unlock");
      },
      getSession: (key) => ({ key, userId: "u1", messages }),
      closeSession: () => events.push("close"),
      onClosed: (session) => {
        events.push("onClosed");
        told.push(session);
      },
    });

    expect(events).toEqual(["lock", "close", "unlock", "onClosed"]);
    expect(told).toEqual([{ key: "s1", userId: "u1", messages }]);
  });

  it("an onClosed that throws doesn't stop the sweep from closing the next session", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", NOW - TIMEOUT);
    scanner.touch("s2", NOW - TIMEOUT);
    const closed: string[] = [];
    const logs: string[] = [];

    await runIdleSessionSweep(scanner, NOW, TIMEOUT, {
      getSession: (key) => ({ key, userId: "u1", messages: [] }),
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

describe("startIdleSessionCron", () => {
  it("runs a sweep on each tick and stop() halts further ticks", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("spaces/X:users/1", 0);
    // Keeps the session idle across real ticks, so more than one is observed.
    const retoucher = setInterval(() => scanner.touch("spaces/X:users/1", 0), 5);

    let sweeps = 0;
    const cron = startIdleSessionCron(
      scanner,
      {
        getSession: (key) => ({ key, userId: "users/1", messages: [] }),
        closeSession: () => {
          sweeps++;
        },
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

  // Regression for #154: a sweep slower than the check interval overlapped the next one.
  it("never starts a sweep while the previous one is still running", async () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("s1", 0);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locks = 0;

    const cron = startIdleSessionCron(
      scanner,
      {
        withSession: async (_key, fn) => {
          locks++;
          await hold;
          await fn();
        },
        getSession: (key) => ({ key, userId: "u1", messages: [] }),
        closeSession: () => {},
      },
      { idleTimeoutMs: 0, checkIntervalMs: 5 },
    );

    await new Promise((r) => setTimeout(r, 40));
    cron.stop();
    release();
    expect(locks).toBe(1);
  });
});
