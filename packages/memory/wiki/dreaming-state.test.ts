/**
 * What the dreaming pass keeps between nights: for each note, the distinct
 * sessions for and against it since its text last changed, and the rule that
 * turns them into a status.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyHash, decide, loadState, saveState, tally, type DreamingState } from "./dreaming-state.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const K = 3;

describe("tally", () => {
  const empty: DreamingState = { notes: {} };

  it("counts distinct sessions: two turns of one session count once", () => {
    const state = tally(empty, "curated/a.md", "h1", [
      { sessionKey: "s1", verdict: "for", at: "2026-11-14T10:00:00.000Z", turnId: "t1" },
      { sessionKey: "s1", verdict: "for", at: "2026-11-14T11:00:00.000Z", turnId: "t2" },
      { sessionKey: "s2", verdict: "against", at: "2026-11-14T12:00:00.000Z", turnId: "t3" },
    ]);
    expect(state.notes["curated/a.md"]).toEqual({ hash: "h1", for: ["s1"], against: ["s2"], evidence: ["t1", "t2", "t3"] });
  });

  it("adds to what it counted on earlier nights for the same text", () => {
    const once = tally(empty, "curated/a.md", "h1", [{ sessionKey: "s1", verdict: "for", at: "x", turnId: "t1" }]);
    const twice = tally(once, "curated/a.md", "h1", [{ sessionKey: "s2", verdict: "for", at: "y", turnId: "t2" }]);
    expect(twice.notes["curated/a.md"]).toEqual({ hash: "h1", for: ["s1", "s2"], against: [], evidence: ["t1", "t2"] });
  });

  it("starts over when the text changed: what was said of the old text doesn't hold", () => {
    const once = tally(empty, "curated/a.md", "h1", [{ sessionKey: "s1", verdict: "against", at: "x", turnId: "t1" }]);
    const changed = tally(once, "curated/a.md", "h2", [{ sessionKey: "s2", verdict: "for", at: "y", turnId: "t2" }]);
    expect(changed.notes["curated/a.md"]).toEqual({ hash: "h2", for: ["s2"], against: [], evidence: ["t2"] });
  });

  it("counts only what came after `since`: a person's decision starts the count over", () => {
    const state = tally(
      empty,
      "curated/a.md",
      "h1",
      [
        { sessionKey: "s1", verdict: "against", at: "2026-11-14T10:00:00.000Z", turnId: "t1" },
        { sessionKey: "s2", verdict: "against", at: "2026-11-16T10:00:00.000Z", turnId: "t2" },
      ],
      "2026-11-15T00:00:00.000Z",
    );
    expect(state.notes["curated/a.md"]).toEqual({ hash: "h1", since: "2026-11-15T00:00:00.000Z", for: [], against: ["s2"], evidence: ["t2"] });
  });

  // Regression: counts from before a person's decision survived it (same text, same hash), so the first
  // use after a `reject` found k sessions against already there and contested the note again.
  it("starts over when `since` moves, even for the same text", () => {
    const contested = tally(empty, "curated/a.md", "h1", ["s1", "s2", "s3"].map((s, i) => ({ sessionKey: s, verdict: "against" as const, at: `2026-11-1${i}T10:00:00.000Z`, turnId: `t${i}` })));
    const afterDecision = tally(contested, "curated/a.md", "h1", [{ sessionKey: "s4", verdict: "for", at: "2026-11-20T10:00:00.000Z", turnId: "t4" }], "2026-11-15T00:00:00.000Z");
    expect(afterDecision.notes["curated/a.md"]).toEqual({ hash: "h1", since: "2026-11-15T00:00:00.000Z", for: ["s4"], against: [], evidence: ["t4"] });
    expect(decide(afterDecision.notes["curated/a.md"]!, K, "validated")).toBeUndefined();
  });

  it("leaves the state it was given as it was", () => {
    tally(empty, "curated/a.md", "h1", [{ sessionKey: "s1", verdict: "for", at: "x", turnId: "t1" }]);
    expect(empty).toEqual({ notes: {} });
  });
});

describe("decide", () => {
  const counts = (forN: number, againstN: number) => ({
    hash: "h",
    for: Array.from({ length: forN }, (_, i) => `f${i}`),
    against: Array.from({ length: againstN }, (_, i) => `a${i}`),
    evidence: [],
  });

  it("contests at k sessions against", () => {
    expect(decide(counts(5, K), K, undefined)).toBe("contested");
    expect(decide(counts(0, K - 1), K, undefined)).toBeUndefined();
  });

  it("verifies at k sessions for and none against", () => {
    expect(decide(counts(K, 0), K, undefined)).toBe("verified");
    expect(decide(counts(K, 1), K, undefined)).toBeUndefined();
    expect(decide(counts(K - 1, 0), K, "unverified")).toBeUndefined();
  });

  it("leaves a status as it is when nothing changes it", () => {
    expect(decide(counts(K, 0), K, "verified")).toBeUndefined();
  });

  it("never turns a person's validated note into verified: only k later sessions against contest it again", () => {
    expect(decide(counts(K, 0), K, "validated")).toBeUndefined();
    expect(decide(counts(0, K), K, "validated")).toBe("contested");
  });
});

describe("bodyHash", () => {
  it("is the same for the same text and differs for another", () => {
    expect(bodyHash("Tag first.")).toBe(bodyHash("Tag first."));
    expect(bodyHash("Tag first.")).not.toBe(bodyHash("Merge first."));
  });
});

describe("loadState and saveState", () => {
  it("keep the state in the data folder, empty before the first pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mercury-dreaming-state-"));
    dirs.push(dir);
    expect(await loadState(dir)).toEqual({ notes: {} });
    const state: DreamingState = { lastPass: "2026-11-14T04:00:00.000Z", notes: { "curated/a.md": { hash: "h", for: ["s1"], against: [], evidence: ["t1"] } } };
    await saveState(dir, state);
    expect(await loadState(dir)).toEqual(state);
  });
});
