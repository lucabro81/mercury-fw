import { describe, expect, it } from "bun:test";
import { SEMANTIC_FACTS_SPACE, ensureSemanticFactsSpace, searchSemanticFactsByTopic, storeSemanticFact } from "./semantic-facts-store.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

const fact = (topic: string, value: string, userId = "users/42") => ({ userId, topic, value, timestamp: "2026-07-20T10:00:00.000Z" });

describe("ensureSemanticFactsSpace", () => {
  it("asks for the space with its dimensions", async () => {
    const index = fakeVectorIndex();
    await ensureSemanticFactsSpace(index, 768);
    expect(index.calls).toEqual([["ensure", "semantic_facts", { dimensions: 768 }]]);
    expect(SEMANTIC_FACTS_SPACE).toBe("semantic_facts");
  });
});

describe("storeSemanticFact", () => {
  // The vector is embedded on `topic` alone, never `topic + value` — embedding
  // the whole fact would make clustering conflate "same topic, different
  // value" with "different topic entirely", defeating the point of the search.
  it("embeds only the topic, not the value, and stores the full entry as payload", async () => {
    const index = fakeVectorIndex();
    const embedded: string[] = [];
    await storeSemanticFact(index, async (text) => (embedded.push(text), [1, 0]), fact("team", "platform"));
    expect(embedded).toEqual(["team"]);
    const [stored] = index.spaces.get("semantic_facts")!;
    expect(stored!.vector).toEqual([1, 0]);
    expect(stored!.payload).toEqual(fact("team", "platform"));
    expect(stored!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("searchSemanticFactsByTopic", () => {
  it("embeds the query topic and searches only the person's facts, nearest first", async () => {
    const index = fakeVectorIndex({
      semantic_facts: [
        { id: "a", vector: [0, 1], payload: fact("role", "dev") },
        { id: "b", vector: [1, 0], payload: fact("team", "platform") },
        { id: "c", vector: [1, 0], payload: fact("team", "other", "users/7") },
      ],
    });
    const embedded: string[] = [];
    const found = await searchSemanticFactsByTopic(index, async (t) => (embedded.push(t), [1, 0]), { userId: "users/42", topic: "team" });
    expect(embedded).toEqual(["team"]);
    expect(found).toEqual([fact("team", "platform"), fact("role", "dev")]);
    expect(index.calls).toEqual([["query", "semantic_facts", { vector: [1, 0], where: { userId: "users/42" }, limit: 5 }]]);
  });

  it("asks for a custom limit instead of the default", async () => {
    const index = fakeVectorIndex();
    await searchSemanticFactsByTopic(index, async () => [1], { userId: "u", topic: "t", limit: 9 });
    expect((index.calls[0]![2] as { limit: number }).limit).toBe(9);
  });

  it("skips points with a malformed payload instead of throwing", async () => {
    const index = fakeVectorIndex({
      semantic_facts: [
        { id: "a", vector: [1], payload: { userId: "users/42", topic: "team" } },
        { id: "b", vector: [1], payload: fact("team", "platform") },
      ],
    });
    expect(await searchSemanticFactsByTopic(index, async () => [1], { userId: "users/42", topic: "team" })).toEqual([fact("team", "platform")]);
  });
});
