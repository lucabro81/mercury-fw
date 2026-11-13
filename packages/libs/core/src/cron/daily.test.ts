import { describe, expect, it } from "bun:test";
import { createDaily } from "./daily.ts";

/** A clock and a ticker the test moves by hand: `at(iso)` sets the time and runs the ticker's callback. */
function fakeTime(start: string) {
  let now = Date.parse(start);
  let tick: (() => void) | undefined;
  let stopped = false;
  return {
    now: () => now,
    every: (fn: () => void) => {
      tick = fn;
      return () => {
        stopped = true;
      };
    },
    at(iso: string) {
      now = Date.parse(iso);
      tick?.();
    },
    stopped: () => stopped,
  };
}

/** Lets the promises of the runs settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("createDaily", () => {
  it("runs the work once a day at its time, in the instance's time zone by default", async () => {
    const time = fakeTime("2026-11-13T01:00:00Z");
    const runs: string[] = [];
    const d = createDaily({ defaultTimeZone: "Europe/Rome", log: () => {}, now: time.now, every: time.every });
    d.daily("wiki:review", { at: "03:00" }, () => void runs.push(new Date(time.now()).toISOString()));
    d.start();

    time.at("2026-11-13T01:59:30Z"); // 02:59 in Rome
    time.at("2026-11-13T02:00:10Z"); // 03:00 in Rome: runs
    time.at("2026-11-13T02:00:40Z"); // still 03:00: not again
    time.at("2026-11-13T02:01:00Z");
    time.at("2026-11-14T02:00:05Z"); // the next day
    await settle();
    expect(runs).toEqual(["2026-11-13T02:00:10.000Z", "2026-11-14T02:00:05.000Z"]);
  });

  it("uses the time zone the work asks for", () => {
    const time = fakeTime("2026-11-13T00:00:00Z");
    const runs: string[] = [];
    const d = createDaily({ defaultTimeZone: "Europe/Rome", log: () => {}, now: time.now, every: time.every });
    d.daily("x", { at: "03:00", timeZone: "America/New_York" }, () => void runs.push("ny"));
    d.start();
    time.at("2026-11-13T02:00:10Z"); // 03:00 in Rome, 21:00 in New York
    time.at("2026-11-13T08:00:10Z"); // 03:00 in New York
    expect(runs).toEqual(["ny"]);
  });

  it("never makes up a run it missed: started after its time, the first run is the next day's", () => {
    const time = fakeTime("2026-11-13T09:00:00Z");
    const runs: number[] = [];
    const d = createDaily({ defaultTimeZone: "UTC", log: () => {}, now: time.now, every: time.every });
    d.daily("x", { at: "03:00" }, () => void runs.push(1));
    d.start();
    time.at("2026-11-13T09:00:30Z");
    time.at("2026-11-13T23:59:30Z");
    expect(runs).toEqual([]);
    time.at("2026-11-14T03:00:00Z");
    expect(runs).toEqual([1]);
  });

  it("runs once on the night the clocks go back, though its minute comes twice", () => {
    // Rome goes back from 03:00 CEST to 02:00 CET on 2026-10-25: 02:30 comes twice.
    const time = fakeTime("2026-10-24T22:00:00Z");
    const runs: number[] = [];
    const d = createDaily({ defaultTimeZone: "Europe/Rome", log: () => {}, now: time.now, every: time.every });
    d.daily("x", { at: "02:30" }, () => void runs.push(1));
    d.start();
    time.at("2026-10-25T00:30:10Z"); // 02:30 CEST
    time.at("2026-10-25T01:30:10Z"); // 02:30 CET
    expect(runs).toEqual([1]);
  });

  it("has no run on the night the clocks skip its minute", () => {
    // Rome goes forward from 02:00 CET to 03:00 CEST on 2026-03-29: 02:30 never comes.
    const time = fakeTime("2026-03-28T22:00:00Z");
    const runs: number[] = [];
    const d = createDaily({ defaultTimeZone: "Europe/Rome", log: () => {}, now: time.now, every: time.every });
    d.daily("x", { at: "02:30" }, () => void runs.push(1));
    d.start();
    for (let m = 0; m <= 120; m += 1) time.at(new Date(Date.parse("2026-03-29T00:00:00Z") + m * 60_000).toISOString());
    expect(runs).toEqual([]);
    time.at("2026-03-30T00:30:00Z"); // 02:30 CEST the next night
    expect(runs).toEqual([1]);
  });

  it("forgets work cancelled before it ran", () => {
    const time = fakeTime("2026-11-13T02:59:00Z");
    const runs: number[] = [];
    const d = createDaily({ defaultTimeZone: "UTC", log: () => {}, now: time.now, every: time.every });
    const cancel = d.daily("x", { at: "03:00" }, () => void runs.push(1));
    cancel();
    d.start();
    time.at("2026-11-13T03:00:10Z");
    expect(runs).toEqual([]);
  });

  it("does nothing until it's started, and stops when told", () => {
    const time = fakeTime("2026-11-13T02:59:00Z");
    const runs: number[] = [];
    const d = createDaily({ defaultTimeZone: "UTC", log: () => {}, now: time.now, every: time.every });
    d.daily("x", { at: "03:00" }, () => void runs.push(1));
    time.at("2026-11-13T03:00:10Z");
    expect(runs).toEqual([]);
    const running = d.start();
    running.stop();
    expect(time.stopped()).toBe(true);
  });

  it("logs work that throws or rejects, and the next day's run goes on", async () => {
    const time = fakeTime("2026-11-13T00:00:00Z");
    const logs: string[] = [];
    let calls = 0;
    const d = createDaily({ defaultTimeZone: "UTC", log: (m) => logs.push(m), now: time.now, every: time.every });
    d.daily("wiki:review", { at: "03:00" }, () => {
      calls += 1;
      if (calls === 1) throw new Error("vault away");
      return Promise.reject(new Error("model away"));
    });
    d.start();
    time.at("2026-11-13T03:00:00Z");
    time.at("2026-11-14T03:00:00Z");
    await settle();
    expect(calls).toBe(2);
    expect(logs).toEqual(['[daily] "wiki:review" failed: vault away', '[daily] "wiki:review" failed: model away']);
  });

  it("refuses a time that isn't HH:MM, and a time zone that doesn't exist", () => {
    const d = createDaily({ defaultTimeZone: "UTC", log: () => {} });
    for (const at of ["3:00", "24:00", "03:60", "03:00:00", ""]) {
      expect(() => d.daily("x", { at }, () => {})).toThrow(`"${at}" isn't a time of day (HH:MM)`);
    }
    expect(() => d.daily("x", { at: "03:00", timeZone: "Mars/Olympus" }, () => {})).toThrow('"Mars/Olympus" isn\'t a time zone');
  });
});
