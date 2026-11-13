import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, type FinishedTurn, type PluginRuntimeContext } from "@mercury-fw/plugin-types";
import type { Cluster, ConsolidationDecision } from "@mercury-fw/wiki";
import { corrections } from "./index.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

/** A model that answers `text` and records who called it. */
function fakeModel(id: string, text: string, used: string[]) {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    doGenerate: async () => {
      used.push(id);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("not streamed");
    },
  };
}

const CORRECTION = JSON.stringify({ elements: [{ topic: "Select Flag", value: "Every --select starts with issues." }] });

/** The plugin built on a fake index, a wiki recording promotions, its jobs run at once. */
async function setUp(opts: { promote?: (tool: string, topic: string, cluster: Cluster) => Promise<ConsolidationDecision> } = {}) {
  const index = fakeVectorIndex();
  const used: string[] = [];
  const jobs: string[] = [];
  const logs: string[] = [];
  const promoted: Array<{ tool: string; topic: string; occurrences: unknown[] }> = [];
  const wiki = {
    notes: {
      promoteCorrection:
        opts.promote ??
        (async (tool: string, topic: string, cluster: Cluster) => {
          promoted.push({ tool, topic, occurrences: await cluster(3) });
          return "written" as const;
        }),
    },
  };
  const ctx = {
    model: fakeModel("turn", "[]", used),
    backgroundModel: fakeModel("background", CORRECTION, used),
    env: {},
    log: (m: string) => void logs.push(m),
    vectorIndex: index,
    embed: async () => [1, 0, 0],
    job: async <T,>(name: string, urgency: string, fn: () => Promise<T>) => (jobs.push(`${name}:${urgency}`), fn()),
  } as unknown as PluginRuntimeContext;
  const built = await corrections({ wiki }).build!(ctx);
  return { afterTurn: built.afterTurn!, index, used, jobs, logs, promoted };
}

const turn = (calls: FinishedTurn["calls"]): FinishedTurn => ({
  sessionKey: "s",
  person: { key: "static:alice" },
  operator: false,
  as: "anyone",
  input: "what's open?",
  answer: "Two issues.",
  calls,
  multiUser: false,
});

const failed = { toolName: "jiraCommand", input: { command: "jira issue search --fields x" }, ok: false, error: "refusing to print without --select" };
const fixed = { toolName: "jiraCommand", input: { command: "jira issue search --select issues.key" }, ok: true };

describe("corrections", () => {
  it("is a plugin acting as no one, needing the vector index and the embedding model, adding nothing for the model", () => {
    const plugin = corrections({ wiki: { notes: { promoteCorrection: async () => "written" } } });
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("corrections");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.needs).toEqual(["vectorIndex", "embedding"]);
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.systemPromptFragment).toBeUndefined();
  });

  it("learns a correction from a failed command fixed in the same turn: a job on the background model, kept in tool_corrections, promoted through the wiki", async () => {
    const { afterTurn, index, used, jobs, promoted, logs } = await setUp();
    await afterTurn(turn([failed, fixed]));
    expect(jobs).toEqual(["correction:soon"]);
    expect(used).toEqual(["background"]);
    expect(index.specs.get("tool_corrections")).toEqual({ dimensions: 3 });
    const kept = (index.spaces.get("tool_corrections") ?? []).map((p) => p.payload);
    expect(kept).toEqual([{ tool: "jira", topic: "select-flag", value: "Every --select starts with issues.", timestamp: expect.any(String) }]);
    expect(promoted).toEqual([{ tool: "jira", topic: "select-flag", occurrences: kept }]);
    expect(logs).toEqual(["[corrections] jira/select-flag: written"]);
  });

  // As before #393: a command the terminal fixed teaches the same rule.
  it("learns from the operator's turns too", async () => {
    const { afterTurn, jobs } = await setUp();
    await afterTurn({ ...turn([failed, fixed]), operator: true });
    expect(jobs).toEqual(["correction:soon"]);
  });

  it("logs a correction the index can't keep, and goes on", async () => {
    const { afterTurn, index, logs, promoted } = await setUp();
    index.fail = new Error("index down");
    await afterTurn(turn([failed, fixed]));
    expect(promoted).toEqual([]);
    expect(logs).toEqual(["[corrections] jira/select-flag: not kept: index down"]);
  });

  it("does nothing, and calls no model, for a turn with nothing to learn from", async () => {
    const { afterTurn, used, jobs } = await setUp();
    await afterTurn(turn([fixed]));
    await afterTurn(turn([fixed, failed]));
    expect(jobs).toEqual([]);
    expect(used).toEqual([]);
  });

  it("keeps the correction when the wiki can't take it, and says so in the log", async () => {
    const { afterTurn, index, logs } = await setUp({
      promote: async () => {
        throw new Error("vault locked");
      },
    });
    await afterTurn(turn([failed, fixed]));
    expect(index.spaces.get("tool_corrections")).toHaveLength(1);
    expect(logs).toEqual(["[corrections] jira/select-flag: kept, not promoted: vault locked"]);
  });
});
