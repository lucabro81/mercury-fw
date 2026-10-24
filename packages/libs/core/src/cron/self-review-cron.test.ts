import { describe, it, expect } from "bun:test";
import { runSelfReviewTick, startSelfReviewCron } from "./self-review-cron.ts";

describe("runSelfReviewTick", () => {
  it("skips the raw-triage pass when raw/ is empty", async () => {
    let rawTriageCalls = 0;
    await runSelfReviewTick({
      listRawEntries: async () => [],
      findOrphans: async () => ["curated/x.md"],
      runRawTriage: async () => {
        rawTriageCalls++;
      },
      runIndexAndOrphan: async () => {},
      runContradictionCheck: async () => {},
    });
    expect(rawTriageCalls).toBe(0);
  });

  it("skips the index/orphan pass when there are no orphans", async () => {
    let indexAndOrphanCalls = 0;
    await runSelfReviewTick({
      listRawEntries: async () => ["raw/x.md"],
      findOrphans: async () => [],
      runRawTriage: async () => {},
      runIndexAndOrphan: async () => {
        indexAndOrphanCalls++;
      },
      runContradictionCheck: async () => {},
    });
    expect(indexAndOrphanCalls).toBe(0);
  });

  it("runs the raw-triage pass with the fetched entries when raw/ is non-empty", async () => {
    let received: string[] | undefined;
    await runSelfReviewTick({
      listRawEntries: async () => ["raw/x.md", "raw/y.md"],
      findOrphans: async () => [],
      runRawTriage: async (entries) => {
        received = entries;
      },
      runIndexAndOrphan: async () => {},
      runContradictionCheck: async () => {},
    });
    expect(received).toEqual(["raw/x.md", "raw/y.md"]);
  });

  it("runs the index/orphan pass with the fetched orphans when there are any", async () => {
    let received: string[] | undefined;
    await runSelfReviewTick({
      listRawEntries: async () => [],
      findOrphans: async () => ["curated/glossary.md"],
      runRawTriage: async () => {},
      runIndexAndOrphan: async (orphans) => {
        received = orphans;
      },
      runContradictionCheck: async () => {},
    });
    expect(received).toEqual(["curated/glossary.md"]);
  });

  // No deterministic pre-check exists for contradictions/missing cross-links
  // (unlike raw/ and orphans) — so this pass always runs on a triggered
  // tick, regardless of the other two signals. That's the whole point of
  // running the nightly self-review at all: it's the only chance this
  // check gets.
  it("always runs the contradiction-check pass, even when raw/ and orphans are both empty", async () => {
    let contradictionCalls = 0;
    await runSelfReviewTick({
      listRawEntries: async () => [],
      findOrphans: async () => [],
      runRawTriage: async () => {},
      runIndexAndOrphan: async () => {},
      runContradictionCheck: async () => {
        contradictionCalls++;
      },
    });
    expect(contradictionCalls).toBe(1);
  });

  // Hard-won convention (AGENTS.md): one bad tick must never take down the
  // rest of Mercury. Here that means one sub-pass failing must not block
  // the other two in the same run.
  it("a failure in one sub-pass doesn't stop the others from running, and gets logged", async () => {
    const loggedMessages: string[] = [];
    let indexAndOrphanCalled = false;
    let contradictionCalled = false;

    await runSelfReviewTick({
      listRawEntries: async () => ["raw/x.md"],
      findOrphans: async () => ["curated/x.md"],
      runRawTriage: async () => {
        throw new Error("model unreachable");
      },
      runIndexAndOrphan: async () => {
        indexAndOrphanCalled = true;
      },
      runContradictionCheck: async () => {
        contradictionCalled = true;
      },
      log: (msg) => loggedMessages.push(msg),
    });

    expect(indexAndOrphanCalled).toBe(true);
    expect(contradictionCalled).toBe(true);
    expect(loggedMessages.some((m) => m.includes("model unreachable"))).toBe(true);
  });
});

describe("startSelfReviewCron", () => {
  it("runs a tick only when the local hour matches and today hasn't run yet, and stop() halts further checks", async () => {
    let ticks = 0;
    let hour = 3;
    const day = new Date(2026, 6, 20, 3, 0, 0);

    const cron = startSelfReviewCron(
      {
        listRawEntries: async () => [],
        findOrphans: async () => [],
        runRawTriage: async () => {},
        runIndexAndOrphan: async () => {},
        runContradictionCheck: async () => {
          ticks++;
        },
      },
      { hour, checkIntervalMs: 10, now: () => day },
    );

    await new Promise((r) => setTimeout(r, 45));
    cron.stop();
    const ticksAtStop = ticks;
    await new Promise((r) => setTimeout(r, 30));

    // Same fake "now" on every check within the window → only ever counts
    // as one calendar day → the tick fires exactly once, not once per check.
    expect(ticksAtStop).toBe(1);
    expect(ticks).toBe(ticksAtStop);
  });

  it("does not run when the local hour doesn't match the configured window", async () => {
    let ticks = 0;
    const notNight = new Date(2026, 6, 20, 14, 0, 0);

    const cron = startSelfReviewCron(
      {
        listRawEntries: async () => [],
        findOrphans: async () => [],
        runRawTriage: async () => {},
        runIndexAndOrphan: async () => {},
        runContradictionCheck: async () => {
          ticks++;
        },
      },
      { hour: 3, checkIntervalMs: 10, now: () => notNight },
    );

    await new Promise((r) => setTimeout(r, 45));
    cron.stop();

    expect(ticks).toBe(0);
  });
});
