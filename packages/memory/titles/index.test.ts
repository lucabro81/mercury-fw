import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, type ConversationStore, type FinishedTurn, type PluginRuntimeContext, type StoredTitle } from "@mercury-fw/plugin-types";
import { titles } from "./index.ts";

/** A model answering `text`, recording that it was called. */
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

/** The plugin built on a store holding `existing` titles, its jobs recorded and run at once. */
async function setUp(existing: StoredTitle[] = []) {
  const set: StoredTitle[] = [];
  const asked: Array<{ userId: string; sessionKeys: string[] }> = [];
  const jobs: string[] = [];
  const used: string[] = [];
  const logs: string[] = [];
  const conversations = {
    titles: async (q: { userId: string; sessionKeys: string[] }) => (asked.push(q), existing.filter((t) => t.userId === q.userId && q.sessionKeys.includes(t.sessionKey))),
    setTitle: async (t: StoredTitle) => void set.push(t),
  } as unknown as ConversationStore;
  const ctx = {
    model: fakeModel("turn", "Wrong model", used),
    backgroundModel: fakeModel("background", "Issue aperte", used),
    env: {},
    log: (m: string) => void logs.push(m),
    conversations,
    job: async <T,>(name: string, urgency: string, fn: () => Promise<T>) => (jobs.push(`${name}:${urgency}`), fn()),
  } as unknown as PluginRuntimeContext;
  const built = await titles().build!(ctx);
  return { afterTurn: built.afterTurn!, set, asked, jobs, used, logs };
}

const turn: FinishedTurn = {
  sessionKey: "http:alice:c1",
  person: { key: "static:alice" },
  operator: false,
  as: "anyone",
  input: "Quali issue ho aperte?",
  answer: "Hai 3 issue aperte.",
  calls: [],
  multiUser: false,
};

describe("titles", () => {
  it("is a plugin acting as no one that needs the conversation store, and adds nothing for the model", async () => {
    const plugin = titles();
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("titles");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.needs).toEqual(["conversationStore"]);
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.systemPromptFragment).toBeUndefined();
  });

  it("titles a conversation after a turn the person wrote, as a job on the background model, the title generated", async () => {
    const { afterTurn, set, asked, jobs, used } = await setUp();
    await afterTurn(turn);
    expect(jobs).toEqual(["title:soon"]);
    expect(used).toEqual(["background"]);
    expect(asked[0]).toEqual({ userId: "static:alice", sessionKeys: ["http:alice:c1"] });
    expect(set).toEqual([{ userId: "static:alice", sessionKey: "http:alice:c1", title: "Issue aperte", source: "generated", updatedAt: expect.any(String) }]);
  });

  it("leaves a conversation with a title as it is", async () => {
    const { afterTurn, set, used } = await setUp([{ userId: "static:alice", sessionKey: "http:alice:c1", title: "Mio", source: "person", updatedAt: "x" }]);
    await afterTurn(turn);
    expect(used).toEqual([]);
    expect(set).toEqual([]);
  });

  // Review of #393: the core read titles through a check of their shape; a malformed row isn't a title.
  it("titles a conversation whose stored title is malformed", async () => {
    const { afterTurn, set } = await setUp([{ userId: "static:alice", sessionKey: "http:alice:c1", title: 42, source: "?" } as unknown as StoredTitle]);
    await afterTurn(turn);
    expect(set.map((t) => t.title)).toEqual(["Issue aperte"]);
  });

  // An opening or a resumed turn has no input: nothing the person wrote to name it from.
  it("titles nothing for a turn the person didn't write, or the operator's", async () => {
    const { afterTurn, set, jobs } = await setUp();
    await afterTurn({ ...turn, input: "" });
    await afterTurn({ ...turn, operator: true });
    expect(jobs).toEqual([]);
    expect(set).toEqual([]);
  });

  it("logs a store that fails and saves nothing", async () => {
    const logs: string[] = [];
    const failing = await titles().build!({
      model: {} as never,
      backgroundModel: {} as never,
      env: {},
      log: (m: string) => void logs.push(m),
      conversations: { titles: async () => Promise.reject(new Error("store down")) } as unknown as ConversationStore,
      job: async <T,>(_n: string, _u: string, fn: () => Promise<T>) => fn(),
    } as unknown as PluginRuntimeContext);
    await failing.afterTurn!(turn);
    expect(logs).toEqual(["[titles] no title for http:alice:c1: store down"]);
  });
});
