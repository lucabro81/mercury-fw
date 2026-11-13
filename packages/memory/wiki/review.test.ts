import { describe, it, expect } from "bun:test";
import { runReview, type ReviewDeps } from "./review.ts";

type Job = ReviewDeps["job"];

/** Runs each pass at once, recording its name. */
function jobs(): { job: Job; names: string[] } {
  const names: string[] = [];
  return { names, job: async (name, _urgency, fn) => (names.push(name), fn()) };
}

/** The review with `deps`, its passes run as jobs that start right away. */
async function review(deps: Omit<ReviewDeps, "job" | "log"> & { log?: ReviewDeps["log"] }): Promise<string[]> {
  const { job, names } = jobs();
  await runReview({ log: () => {}, ...deps, job });
  return names;
}

describe("runReview", () => {
  it("skips the raw-triage pass when raw/ is empty", async () => {
    let rawTriageCalls = 0;
    await review({
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
    await review({
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
    await review({
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
    await review({
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
    await review({
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

    await review({
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

describe("runReview: the jobs", () => {
  it("runs each pass as a job of its own, nobody waiting, skipping the ones with nothing to do", async () => {
    const urgencies: string[] = [];
    const names: string[] = [];
    await runReview({
      listRawEntries: async () => ["raw/x.md"],
      findOrphans: async () => [],
      runRawTriage: async () => {},
      runIndexAndOrphan: async () => {},
      runContradictionCheck: async () => {},
      log: () => {},
      job: async (name, urgency, fn) => (names.push(name), urgencies.push(urgency), fn()),
    });
    expect(names).toEqual(["review-raw", "review-contradictions"]);
    expect(urgencies).toEqual(["idle", "idle"]);
  });

  it("a job that's dropped (the agent stopping) is logged like a pass that failed", async () => {
    const logs: string[] = [];
    await runReview({
      listRawEntries: async () => [],
      findOrphans: async () => [],
      runRawTriage: async () => {},
      runIndexAndOrphan: async () => {},
      runContradictionCheck: async () => {},
      log: (m) => logs.push(m),
      job: async () => {
        throw new Error("stopped");
      },
    });
    expect(logs).toEqual(["review contradiction-check pass failed: Error: stopped"]);
  });
});
