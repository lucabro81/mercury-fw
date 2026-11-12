import { describe, expect, it } from "bun:test";
import { getSelfHealth } from "./health.ts";
import { fakeConversationStore } from "./memory/__fixtures__/fake-conversation-store.ts";
import { fakeVectorIndex } from "./memory/__fixtures__/fake-vector-index.ts";

const ollamaUp = (async () => Response.json({ models: [{ name: "m" }] })) as unknown as typeof fetch;
const ollamaDown = (async () => {
  throw new Error("down");
}) as unknown as typeof fetch;

describe("getSelfHealth", () => {
  // #379: what answers is the declared store and index, whatever they are; one not declared is `null`.
  it("says whether the conversation store, the vector index and the model endpoint answer", async () => {
    const store = fakeConversationStore();
    const index = fakeVectorIndex();
    index.fail = new Error("index down");
    const health = await getSelfHealth({ store, index, ollamaHost: "http://o", fetchFn: ollamaUp });
    expect(health).toMatchObject({ conversationStoreReachable: true, vectorIndexReachable: false, ollamaReachable: true });
    expect(health.uptimeSeconds).toBeGreaterThan(0);
    expect(health.memory.rss).toBeGreaterThan(0);
  });

  it("reports null for a store or an index the instance doesn't declare", async () => {
    expect(await getSelfHealth({ ollamaHost: "http://o", fetchFn: ollamaDown })).toMatchObject({
      conversationStoreReachable: null,
      vectorIndexReachable: null,
      ollamaReachable: false,
    });
  });

  it("counts a health check that throws as unreachable", async () => {
    const store = fakeConversationStore();
    store.health = async () => {
      throw new Error("boom");
    };
    expect((await getSelfHealth({ store, ollamaHost: "http://o", fetchFn: ollamaUp })).conversationStoreReachable).toBe(false);
  });
});
