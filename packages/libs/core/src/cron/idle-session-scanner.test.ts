import { describe, it, expect } from "bun:test";
import { createIdleSessionScanner } from "./idle-session-scanner.ts";

describe("createIdleSessionScanner", () => {
  it("reports no idle sessions before any activity is tracked", () => {
    const scanner = createIdleSessionScanner();
    expect(scanner.scanIdle(1_000_000, 30 * 60_000)).toEqual([]);
  });

  it("does not report a session as idle before the timeout elapses", () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("space/X:users/1", 0);
    expect(scanner.scanIdle(29 * 60_000, 30 * 60_000)).toEqual([]);
  });

  it("reports a session as idle once the timeout has elapsed", () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("space/X:users/1", 0);
    expect(scanner.scanIdle(30 * 60_000, 30 * 60_000)).toEqual(["space/X:users/1"]);
  });

  it("a later touch resets the idle clock", () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("space/X:users/1", 0);
    scanner.touch("space/X:users/1", 20 * 60_000);
    // 30 min after the first touch, but only 10 min after the second — not idle yet
    expect(scanner.scanIdle(30 * 60_000, 30 * 60_000)).toEqual([]);
  });

  it("tracks multiple sessions independently", () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("a", 0);
    scanner.touch("b", 10 * 60_000);
    const idle = scanner.scanIdle(30 * 60_000, 30 * 60_000);
    expect(idle).toEqual(["a"]);
  });

  it("clear removes a session from tracking so it never reports idle again", () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("a", 0);
    scanner.clear("a");
    expect(scanner.scanIdle(30 * 60_000, 30 * 60_000)).toEqual([]);
  });

  it("isIdle tells whether one session is idle at a given moment", () => {
    const scanner = createIdleSessionScanner();
    scanner.touch("a", 0);
    expect(scanner.isIdle("a", 30 * 60_000, 30 * 60_000)).toBe(true);
    expect(scanner.isIdle("a", 29 * 60_000, 30 * 60_000)).toBe(false);
    expect(scanner.isIdle("untracked", 30 * 60_000, 30 * 60_000)).toBe(false);
  });
});
