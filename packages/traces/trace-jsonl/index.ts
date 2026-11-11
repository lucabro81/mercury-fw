/**
 * `@mercury-fw/trace-jsonl` — a trace sink that writes every event as one JSON
 * line, one file per UTC day (`YYYY-MM-DD.jsonl`) in the folder the core gives
 * it. Declared in `mercury.config.ts` as `traces: { sink: jsonlTraces() }`.
 *
 * It keeps the last `keepDays` days that had any activity, not the last
 * `keepDays` calendar days: an instance that works two days and then sits idle
 * for a month still has those two days. Older day files go when the sink
 * starts and whenever a new day's file opens; any other file in the folder is
 * left alone.
 *
 * Writes are queued one after the other so lines never interleave, and never
 * throw to the caller: a failing write is logged once until writing works
 * again.
 */
import { appendFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TraceEvent, TraceSinkPlugin } from "@mercury-fw/channel-types";

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** The UTC day `event` belongs to, as its file names it; today's when its time can't be read. */
function dayOf(event: TraceEvent): string {
  const at = new Date(event.at);
  return (Number.isNaN(at.getTime()) ? new Date() : at).toISOString().slice(0, 10);
}

/** Deletes the day files in `dir` beyond the newest `keepDays`. */
async function prune(dir: string, keepDays: number): Promise<void> {
  const days = (await readdir(dir)).filter((name) => DAY_FILE.test(name)).sort();
  for (const name of days.slice(0, Math.max(0, days.length - keepDays))) {
    await rm(join(dir, name), { force: true });
  }
}

/** The JSONL trace sink, keeping the last `keepDays` days with activity (7 when left out). Throws when `keepDays` isn't a whole number from 1 up. */
export function jsonlTraces(options: { keepDays?: number } = {}): TraceSinkPlugin {
  const keepDays = options.keepDays ?? 7;
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    throw new Error("jsonlTraces: keepDays must be a whole number from 1 up");
  }
  return {
    // A literal, not the imported constant: importing it would report whichever contract is installed, not the one this sink was written for.
    apiVersion: 1,
    name: "jsonl",
    build: ({ dir, log }) => {
      let queue: Promise<void> = Promise.resolve();
      let failing = false;
      let openDay: string | undefined;

      const enqueue = (op: () => Promise<void>): void => {
        queue = queue.then(op).then(
          () => {
            failing = false;
          },
          (err: unknown) => {
            if (!failing) {
              failing = true;
              log(`[traces] couldn't write to ${dir}, events are being lost: ${String(err)}`);
            }
          },
        );
      };

      enqueue(() => prune(dir, keepDays));

      return {
        write: (event) => {
          const day = dayOf(event);
          const line = `${JSON.stringify(event)}\n`;
          enqueue(async () => {
            await appendFile(join(dir, `${day}.jsonl`), line);
            if (day !== openDay) {
              openDay = day;
              await prune(dir, keepDays);
            }
          });
        },
        flush: () => queue,
      };
    },
  };
}
