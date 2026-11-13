/**
 * Work the plugins run every day at a set time (`PluginRuntimeContext.daily`,
 * #393): the wiki's nightly review, and whatever a plugin keeps up at night.
 *
 * Every registered piece of work is checked a few times a minute against the
 * time in its own time zone: it runs when the clock there shows its `HH:MM`,
 * at most once per local date. So a night whose clocks go back (the minute
 * comes twice) still has one run, a night whose clocks skip the minute has
 * none, and a run the instance wasn't up for is never made up later.
 *
 * Registering happens while the plugins build; nothing runs until `start`,
 * which only the long-running service calls (with the other crons), never the
 * dev REPL.
 *
 * Used by: `compose.ts`, which hands `daily` to the plugin loader and starts
 * it in `startCrons`.
 */
import type { Daily } from "@mercury-fw/plugin-types";

/** How often the clocks are checked: under half a minute, so no minute goes by unseen. */
const CHECK_MS = 20_000;

/** A time of day, 24 hours, two digits each. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One registered piece of work: its name, its time and zone, the local date it last ran on. */
type Entry = { name: string; at: string; timeZone: string; fn: () => void | Promise<void>; lastRun?: string };

export type DailyScheduler = {
  /** Registers work (see `Daily`) and returns what cancels it; throws on a time or a time zone that can't be. */
  daily: (...args: Parameters<Daily>) => () => void;
  /** Starts checking the clocks; returns the stopper. */
  start: () => { stop: () => void };
};

/** The date (`YYYY-MM-DD`) and the time (`HH:MM`) the clock shows at `ms` in `timeZone`. */
function localClock(ms: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Whether `timeZone` names a zone this runtime knows. */
function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the scheduler. `defaultTimeZone` is the instance's (`i18n.timeZone`);
 * `now` and `every` are test seams (the clock, and a repeating timer returning
 * its stopper).
 */
export function createDaily(deps: {
  defaultTimeZone: string;
  log: (message: string) => void;
  now?: () => number;
  every?: (fn: () => void, ms: number) => () => void;
}): DailyScheduler {
  const now = deps.now ?? Date.now;
  const every =
    deps.every ??
    ((fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });
  const entries: Entry[] = [];

  /** Runs `entry`'s work without waiting for it, logging a throw or a rejection. */
  function run(entry: Entry): void {
    const failed = (err: unknown) => deps.log(`[daily] "${entry.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      Promise.resolve(entry.fn()).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /** Runs every entry whose minute it is, once per local date. */
  function check(): void {
    const ms = now();
    for (const entry of entries) {
      const clock = localClock(ms, entry.timeZone);
      if (clock.time !== entry.at || entry.lastRun === clock.date) continue;
      entry.lastRun = clock.date;
      run(entry);
    }
  }

  return {
    daily(name, when, fn) {
      if (!TIME_OF_DAY.test(when.at)) throw new Error(`"${when.at}" isn't a time of day (HH:MM)`);
      const timeZone = when.timeZone ?? deps.defaultTimeZone;
      if (!isTimeZone(timeZone)) throw new Error(`"${timeZone}" isn't a time zone`);
      const entry: Entry = { name, at: when.at, timeZone, fn };
      entries.push(entry);
      return () => {
        const at = entries.indexOf(entry);
        if (at >= 0) entries.splice(at, 1);
      };
    },
    start() {
      const stop = every(check, CHECK_MS);
      return { stop };
    },
  };
}
