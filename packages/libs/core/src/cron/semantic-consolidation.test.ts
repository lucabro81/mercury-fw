import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consolidateSemanticFact,
  consolidateToolCorrection,
  defaultConfidenceForCount,
  DEFAULT_CONSOLIDATION_K,
  type ConsolidationDeps,
  type ToolCorrectionConsolidationDeps,
} from "./semantic-consolidation.ts";
import type { SemanticFactEntry } from "../memory/semantic-facts-store.ts";
import type { ToolCorrectionEntry } from "../memory/tool-corrections-store.ts";
import { readVisible } from "../identity/vault-access.ts";
import { writeInferredNote, writeToolCorrectionNote, type WriteCondition } from "../wiki/wiki-note.ts";
import { initVault } from "../wiki/vault-init.ts";

const VAULT = "/vault";
type FakeWriter = (vaultPath: string, subject: string, topic: string, fields: unknown, body: string) => void | Promise<void>;

/**
 * Stands in for a vault writer: evaluates the consolidation's `when` against
 * `incumbent` (the note's current text, `null` for none) the way the real
 * writer does inside the commit chain, and calls `write` only if it passes.
 */
function fakeWriter(write: FakeWriter = () => {}, incumbent: string | null = null) {
  return async (vaultPath: string, subject: string, topic: string, fields: unknown, body: string, condition?: WriteCondition) => {
    if (condition?.when && !condition.when(incumbent)) return false;
    await write(vaultPath, subject, topic, fields, body);
    return true;
  };
}

function baseDeps(
  overrides: Partial<Omit<ConsolidationDeps, "writeInferredNoteFn">> & { write?: FakeWriter; incumbent?: string | null },
): ConsolidationDeps {
  const { write, incumbent, ...rest } = overrides;
  return {
    vaultPath: VAULT,
    clusterFn: async () => [],
    writeInferredNoteFn: fakeWriter(write, incumbent) as ConsolidationDeps["writeInferredNoteFn"],
    k: 5,
    confidenceForCount: () => "medium",
    ...rest,
  };
}

function entry(value: string, timestamp: string, topic = "preferred-language"): SemanticFactEntry {
  return { userId: "google-chat:users/42", topic, value, timestamp };
}

describe("consolidateSemanticFact", () => {
  it("writes a new inferred note when no incumbent exists (first promotion)", async () => {
    let written: unknown;
    const deps = baseDeps({
      clusterFn: async () => [entry("italiano", "2026-07-20T09:00:00.000Z")],
      write: (vaultPath, userId, topic, fields, body) => {
        written = { vaultPath, userId, topic, fields, body };
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    // The same user key Qdrant's facts carry goes to the writer as-is:
    // encoding it for the vault is userArea's job, done once.
    expect(written).toEqual({
      vaultPath: VAULT,
      userId: "google-chat:users/42",
      topic: "preferred-language",
      fields: { confidence: "medium", derived_from: ["2026-07-20T09:00:00.000Z"], last_reviewed: expect.any(String) },
      body: "italiano",
    });
  });

  it("does not write when the challenger's count does not exceed the incumbent's (no update on a tie)", async () => {
    let writeCalls = 0;
    const deps = baseDeps({
      clusterFn: async () => [entry("italiano", "2026-07-20T09:00:00.000Z")],
      incumbent:
        [
          "---",
          "type: inferred",
          "source: agent",
          "confidence: medium",
          "derived_from:",
          "  - 2026-07-10T09:00:00.000Z",
          "last_reviewed: 2026-07-10T09:00:00.000Z",
          "---",
          "italiano",
        ].join("\n"),
      write: () => {
        writeCalls++;
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect(writeCalls).toBe(0);
  });

  it("writes when the challenger's count exceeds the incumbent's stored count", async () => {
    let written: unknown;
    const deps = baseDeps({
      clusterFn: async () => [
        entry("inglese", "2026-07-18T09:00:00.000Z"),
        entry("inglese", "2026-07-19T09:00:00.000Z"),
      ],
      incumbent:
        [
          "---",
          "type: inferred",
          "source: agent",
          "confidence: low",
          "derived_from:",
          "  - 2026-07-01T09:00:00.000Z",
          "last_reviewed: 2026-07-01T09:00:00.000Z",
          "---",
          "italiano",
        ].join("\n"),
      write: (vaultPath, userId, topic, fields, body) => {
        written = { vaultPath, userId, topic, fields, body };
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect(written).toEqual({
      vaultPath: VAULT,
      userId: "google-chat:users/42",
      topic: "preferred-language",
      fields: {
        confidence: "medium",
        derived_from: ["2026-07-18T09:00:00.000Z", "2026-07-19T09:00:00.000Z"],
        last_reviewed: expect.any(String),
      },
      body: "inglese",
    });
  });

  it("does nothing when the cluster is empty", async () => {
    let writeCalls = 0;
    const deps = baseDeps({
      clusterFn: async () => [],
      write: () => {
        writeCalls++;
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect(writeCalls).toBe(0);
  });

  it("does nothing when there's a tie for the most common value — no clear dominant value this round", async () => {
    let writeCalls = 0;
    const deps = baseDeps({
      clusterFn: async () => [
        entry("italiano", "2026-07-18T09:00:00.000Z"),
        entry("inglese", "2026-07-19T09:00:00.000Z"),
      ],
      write: () => {
        writeCalls++;
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect(writeCalls).toBe(0);
  });

  // The cluster search is similarity-based (see searchSemanticFactsByTopic),
  // so it can surface near-topic noise ("team" vs "current-team") that
  // normalization alone doesn't dedupe — filtering to an exact topic match
  // before counting is what keeps the count honest.
  it("ignores cluster entries whose topic isn't an exact match, even if the search returned them", async () => {
    let written: unknown;
    const deps = baseDeps({
      clusterFn: async () => [
        entry("italiano", "2026-07-20T09:00:00.000Z", "preferred-language"),
        entry("platform", "2026-07-20T09:00:00.000Z", "current-team"),
      ],
      write: (vaultPath, userId, topic, fields, body) => {
        written = { vaultPath, userId, topic, fields, body };
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect((written as { body: string }).body).toBe("italiano");
    expect((written as { fields: { derived_from: string[] } }).fields.derived_from).toEqual([
      "2026-07-20T09:00:00.000Z",
    ]);
  });

  it("passes confidenceForCount(dominantCount, k) through to the frontmatter", async () => {
    let receivedArgs: [number, number] | undefined;
    const deps = baseDeps({
      clusterFn: async () => [entry("italiano", "2026-07-20T09:00:00.000Z")],
      confidenceForCount: (count, k) => {
        receivedArgs = [count, k];
        return "high";
      },
      k: 7,
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect(receivedArgs).toEqual([1, 7]);
  });

  it("works correctly when the cluster has fewer than k entries (window not yet full)", async () => {
    let written: unknown;
    const deps = baseDeps({
      k: 10,
      clusterFn: async () => [entry("italiano", "2026-07-20T09:00:00.000Z")],
      write: (vaultPath, userId, topic, fields, body) => {
        written = { vaultPath, userId, topic, fields, body };
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect((written as { body: string }).body).toBe("italiano");
  });

  it("requests the cluster scoped to k", async () => {
    let receivedLimit: number | undefined;
    const deps = baseDeps({
      k: 12,
      clusterFn: async (_userId, _topic, limit) => {
        receivedLimit = limit;
        return [];
      },
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect(receivedLimit).toBe(12);
  });

  it("falls back to DEFAULT_CONSOLIDATION_K when k isn't provided", async () => {
    let receivedLimit: number | undefined;
    const deps = baseDeps({
      clusterFn: async (_userId, _topic, limit) => {
        receivedLimit = limit;
        return [];
      },
      k: undefined as unknown as number,
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect(receivedLimit).toBe(DEFAULT_CONSOLIDATION_K);
  });

  it("falls back to defaultConfidenceForCount when confidenceForCount isn't provided", async () => {
    let written: unknown;
    const deps = baseDeps({
      clusterFn: async () => [entry("italiano", "2026-07-20T09:00:00.000Z")],
      write: (vaultPath, userId, topic, fields, body) => {
        written = { fields, body };
      },
      confidenceForCount: undefined as unknown as ConsolidationDeps["confidenceForCount"],
    });

    await consolidateSemanticFact("google-chat:users/42", "preferred-language", deps);

    expect((written as { fields: { confidence: string } }).fields.confidence).toBe(
      defaultConfidenceForCount(1, DEFAULT_CONSOLIDATION_K),
    );
  });
});

describe("consolidateSemanticFact — real wiki read/write (regression: userId encoding)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeTempVault(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mercury-semantic-consolidation-test-"));
    tempDirs.push(dir);
    await initVault(dir);
    return dir;
  }

  // The bug this guards against: writeInferredNote's assertNoPathSeparator
  // rejects any userId containing "/", but every real Google Chat userId
  // has that shape ("users/<id>") — so consolidation against a real user
  // always threw, silently swallowed by idle-session-cron.ts's own
  // try/catch. Exercising the REAL writeInferredNote (not
  // fakes, unlike every test above) is what catches this: a fake never
  // enforces the path-separator guard, so this exact mismatch was never
  // intercepted by the suite before this test existed.
  it("promotes a fact for a real (slash-containing) id without throwing, where the person's own wiki tools find it", async () => {
    const vaultPath = await makeTempVault();
    const key = "google-chat:users/100203105076128909015";

    await consolidateSemanticFact(key, "team", {
      vaultPath,
      clusterFn: async () => [{ userId: key, topic: "team", value: "platform", timestamp: "2026-07-20T09:00:00.000Z" }],
      writeInferredNoteFn: writeInferredNote,
    });

    // Read the way the person's own wiki tools read it: proves the promoted
    // note lands where the model can find it.
    const content = await readVisible({ vaultPath, key }, "personal/inferred/team.md");
    expect(content).toContain("platform");
  });

  it("re-clustering the same real userId reads back the incumbent it just wrote, instead of throwing on the raw slash", async () => {
    const vaultPath = await makeTempVault();
    const key = "google-chat:users/100203105076128909015";
    const deps: ConsolidationDeps = {
      vaultPath,
      clusterFn: async () => [{ userId: key, topic: "team", value: "platform", timestamp: "2026-07-20T09:00:00.000Z" }],
      writeInferredNoteFn: writeInferredNote,
    };

    await consolidateSemanticFact(key, "team", deps);

    // Second round: same value, same single occurrence — not strictly
    // greater than the incumbent's own count, so it must not throw trying
    // to read the incumbent back (would throw before the fix) and must not
    // re-write (tie, not an improvement).
    await consolidateSemanticFact(key, "team", deps);

    const content = await readVisible({ vaultPath, key }, "personal/inferred/team.md");
    expect(content).toContain("platform");
  });
});

function baseToolDeps(
  overrides: Partial<Omit<ToolCorrectionConsolidationDeps, "writeNoteFn">> & { write?: FakeWriter; incumbent?: string | null },
): ToolCorrectionConsolidationDeps {
  const { write, incumbent, ...rest } = overrides;
  return {
    vaultPath: VAULT,
    clusterFn: async () => [],
    writeNoteFn: fakeWriter(write, incumbent) as ToolCorrectionConsolidationDeps["writeNoteFn"],
    k: 5,
    confidenceForCount: () => "medium",
    ...rest,
  };
}

function toolEntry(value: string, timestamp: string, topic = "select-prefix"): ToolCorrectionEntry {
  return { tool: "jira", topic, value, timestamp };
}

describe("consolidateToolCorrection", () => {
  it("writes a new tool-correction note when no incumbent exists (first promotion)", async () => {
    let written: unknown;
    const deps = baseToolDeps({
      clusterFn: async () => [toolEntry("ogni --select deve iniziare per issues.", "2026-07-20T09:00:00.000Z")],
      write: (vaultPath, tool, topic, fields, body) => {
        written = { vaultPath, tool, topic, fields, body };
      },
    });

    await consolidateToolCorrection("jira", "select-prefix", deps);

    expect(written).toEqual({
      vaultPath: VAULT,
      tool: "jira",
      topic: "select-prefix",
      fields: { confidence: "medium", derived_from: ["2026-07-20T09:00:00.000Z"], last_reviewed: expect.any(String) },
      body: "ogni --select deve iniziare per issues.",
    });
  });

  it("does not write when the challenger's count does not exceed the incumbent's (no update on a tie)", async () => {
    let writeCalls = 0;
    const deps = baseToolDeps({
      clusterFn: async () => [toolEntry("v", "2026-07-20T09:00:00.000Z")],
      incumbent:
        ["---", "type: inferred", "source: agent", "confidence: medium", "derived_from:", "  - 2026-07-10T09:00:00.000Z", "last_reviewed: 2026-07-10T09:00:00.000Z", "---", "v"].join("\n"),
      write: () => {
        writeCalls++;
      },
    });

    await consolidateToolCorrection("jira", "select-prefix", deps);

    expect(writeCalls).toBe(0);
  });

  it("does nothing when the cluster is empty", async () => {
    let writeCalls = 0;
    const deps = baseToolDeps({
      write: () => {
        writeCalls++;
      },
    });

    await consolidateToolCorrection("jira", "select-prefix", deps);

    expect(writeCalls).toBe(0);
  });

  it("ignores cluster entries whose topic isn't an exact match", async () => {
    let written: unknown;
    const deps = baseToolDeps({
      clusterFn: async () => [
        toolEntry("v1", "2026-07-20T09:00:00.000Z", "select-prefix"),
        toolEntry("v2", "2026-07-20T09:00:00.000Z", "assignee-operator"),
      ],
      write: (vaultPath, tool, topic, fields, body) => {
        written = { body };
      },
    });

    await consolidateToolCorrection("jira", "select-prefix", deps);

    expect((written as { body: string }).body).toBe("v1");
  });

  it("falls back to DEFAULT_CONSOLIDATION_K when k isn't provided", async () => {
    let receivedLimit: number | undefined;
    const deps = baseToolDeps({
      clusterFn: async (_tool, _topic, limit) => {
        receivedLimit = limit;
        return [];
      },
      k: undefined as unknown as number,
    });

    await consolidateToolCorrection("jira", "select-prefix", deps);

    expect(receivedLimit).toBe(DEFAULT_CONSOLIDATION_K);
  });
});

// Same reasoning as consolidateSemanticFact's own "real wiki read/write"
// suite above: exercising the real writeToolCorrectionNote/readWikiFileInRoots
// is what proves this actually lands at a path readable by every user's
// wiki tools (curated/, not scoped to one userId's inferred/).
describe("consolidateToolCorrection — real wiki read/write", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeTempVault(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mercury-tool-correction-test-"));
    tempDirs.push(dir);
    await initVault(dir);
    return dir;
  }

  it("promotes a correction to curated/standards/<tool>-<topic>.md, readable at the same path the model's wiki tools use", async () => {
    const vaultPath = await makeTempVault();

    await consolidateToolCorrection("jira", "select-prefix", {
      vaultPath,
      clusterFn: async () => [toolEntry("ogni --select deve iniziare per issues.", "2026-07-20T09:00:00.000Z")],
      writeNoteFn: writeToolCorrectionNote,
    });

    const content = await readVisible({ vaultPath, key: "static:anyone" }, "curated/standards/jira-select-prefix.md");
    expect(content).toContain("ogni --select deve iniziare per issues.");
  });

  // Regression guard: the incumbent's count used to be read through a path
  // missing the "curated/" prefix, which always failed and was silently
  // treated as "no incumbent", so every re-consolidation behaved like a first
  // promotion (caught live). The count is now read from the note's real
  // current content, inside the writer; only the real writer can show it.
  it("does not re-promote on a second consolidation of the same single occurrence (tie against the real incumbent it just wrote)", async () => {
    const vaultPath = await makeTempVault();
    const deps = {
      vaultPath,
      clusterFn: async () => [toolEntry("ogni --select deve iniziare per issues.", "2026-07-20T09:00:00.000Z")],
      writeNoteFn: writeToolCorrectionNote,
      k: 1,
    };

    await consolidateToolCorrection("jira", "select-prefix", deps);
    const firstWrite = await readVisible({ vaultPath, key: "static:anyone" }, "curated/standards/jira-select-prefix.md");

    // Same single occurrence again: incumbent count (1) must be read back
    // correctly and compared as a tie (1 <= 1), not silently treated as 0
    // (which would look like "no incumbent" and re-write every time).
    await consolidateToolCorrection("jira", "select-prefix", deps);
    const secondRead = await readVisible({ vaultPath, key: "static:anyone" }, "curated/standards/jira-select-prefix.md");

    expect(secondRead).toBe(firstWrite);
  });

  // Regression for #154: the incumbent's count was read before the write,
  // outside the commit chain, so two people's turns consolidating the same
  // correction both read the same incumbent and the last write won, even
  // when it had less support.
  it("of two concurrent consolidations, the better-supported one stays", async () => {
    const vaultPath = await makeTempVault();
    const strong = ["2026-07-20T09:00:00.000Z", "2026-07-21T09:00:00.000Z"].map((t) => toolEntry("strong", t));
    const weak = [toolEntry("weak", "2026-07-22T09:00:00.000Z")];
    const slowly = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 30));

    await Promise.all([
      consolidateToolCorrection("jira", "select-prefix", { vaultPath, clusterFn: async () => strong, writeNoteFn: writeToolCorrectionNote }),
      consolidateToolCorrection("jira", "select-prefix", { vaultPath, clusterFn: () => slowly(weak), writeNoteFn: writeToolCorrectionNote }),
    ]);

    const content = await readVisible({ vaultPath, key: "static:anyone" }, "curated/standards/jira-select-prefix.md");
    expect(content).toContain("strong");
  });
});

describe("defaultConfidenceForCount", () => {
  it("is low on a single, unconfirmed occurrence", () => {
    expect(defaultConfidenceForCount(1, 5)).toBe("low");
  });

  it("is medium once repeated but the window isn't unanimous", () => {
    expect(defaultConfidenceForCount(3, 5)).toBe("medium");
  });

  it("is high once the dominant value fills the whole tracked window", () => {
    expect(defaultConfidenceForCount(5, 5)).toBe("high");
  });
});
