import { describe, expect, it } from "bun:test";
import { TOOL_CORRECTIONS_SPACE, ensureToolCorrectionsSpace, searchToolCorrectionsByTopic, storeToolCorrection } from "./store.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

const correction = (tool: string, topic: string, value: string) => ({ tool, topic, value, timestamp: "2026-07-20T10:00:00.000Z" });

describe("ensureToolCorrectionsSpace", () => {
  it("asks for the space with its dimensions", async () => {
    const index = fakeVectorIndex();
    await ensureToolCorrectionsSpace(index, 768);
    expect(index.calls).toEqual([["ensure", "tool_corrections", { dimensions: 768 }]]);
    expect(TOOL_CORRECTIONS_SPACE).toBe("tool_corrections");
  });
});

describe("storeToolCorrection", () => {
  it("embeds only the topic, not the value, and stores the full entry as payload", async () => {
    const index = fakeVectorIndex();
    const embedded: string[] = [];
    await storeToolCorrection(index, async (text) => (embedded.push(text), [1, 0]), correction("jira", "jql", "use project = KAN"));
    expect(embedded).toEqual(["jql"]);
    const [stored] = index.spaces.get("tool_corrections")!;
    expect(stored!.vector).toEqual([1, 0]);
    expect(stored!.payload).toEqual(correction("jira", "jql", "use project = KAN"));
  });
});

describe("searchToolCorrectionsByTopic", () => {
  it("embeds the query topic and searches only that tool's corrections, nearest first", async () => {
    const index = fakeVectorIndex({
      tool_corrections: [
        { id: "a", vector: [0, 1], payload: correction("jira", "fields", "x") },
        { id: "b", vector: [1, 0], payload: correction("jira", "jql", "y") },
        { id: "c", vector: [1, 0], payload: correction("bitbucket", "jql", "z") },
      ],
    });
    const embedded: string[] = [];
    const found = await searchToolCorrectionsByTopic(index, async (t) => (embedded.push(t), [1, 0]), { tool: "jira", topic: "jql" });
    expect(embedded).toEqual(["jql"]);
    expect(found).toEqual([correction("jira", "jql", "y"), correction("jira", "fields", "x")]);
    expect(index.calls).toEqual([["query", "tool_corrections", { vector: [1, 0], where: { tool: "jira" }, limit: 5 }]]);
  });

  it("asks for a custom limit instead of the default", async () => {
    const index = fakeVectorIndex();
    await searchToolCorrectionsByTopic(index, async () => [1], { tool: "jira", topic: "t", limit: 3 });
    expect((index.calls[0]![2] as { limit: number }).limit).toBe(3);
  });

  it("skips points with a malformed payload instead of throwing", async () => {
    const index = fakeVectorIndex({
      tool_corrections: [
        { id: "a", vector: [1], payload: { tool: "jira" } },
        { id: "b", vector: [1], payload: correction("jira", "jql", "y") },
      ],
    });
    expect(await searchToolCorrectionsByTopic(index, async () => [1], { tool: "jira", topic: "jql" })).toEqual([correction("jira", "jql", "y")]);
  });
});
