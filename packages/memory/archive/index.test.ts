import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, type ConversationStore, type PluginRuntimeContext, type StoredMessage, type TurnRecord } from "@mercury-fw/plugin-types";
import { archive } from "./index.ts";

/** A store keeping what's appended, failing with `fail` when set. */
function store(fail?: Error) {
  const stored: StoredMessage[] = [];
  const s = {
    append: async (m: StoredMessage) => {
      if (fail !== undefined) throw fail;
      stored.push(m);
    },
  } as unknown as ConversationStore;
  return { s, stored };
}

/** The plugin's `onTurnRecord`, built on `conversations`. */
async function built(conversations: ConversationStore) {
  const ctx = { model: {} as never, env: {}, log: () => {}, conversations } as unknown as PluginRuntimeContext;
  const contributions = await archive().build!(ctx);
  return contributions.onTurnRecord!;
}

const turn: TurnRecord = {
  sessionKey: "http:alice:c1",
  person: { key: "static:alice" },
  operator: false,
  as: "anyone",
  kind: "turn",
  turnId: "t1",
  multiUser: false,
  outcome: "done",
  origin: "person",
  input: "What's open on KAN?",
  startedAt: "2026-11-13T10:00:00.000Z",
  endedAt: "2026-11-13T10:00:05.000Z",
  answer: { content: "Two issues.", displays: ["- KAN-1"] },
};

describe("archive", () => {
  it("is a plugin acting as no one that needs the conversation store, and adds nothing for the model", async () => {
    const plugin = archive();
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("archive");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.needs).toEqual(["conversationStore"]);
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.systemPromptFragment).toBeUndefined();
    const contributions = await plugin.build!({ model: {} as never, env: {}, log: () => {}, conversations: store().s } as unknown as PluginRuntimeContext);
    expect(Object.keys(contributions)).toEqual(["onTurnRecord"]);
  });

  it("keeps each message a turn leaves, in order, each under an id of its own", async () => {
    const { s, stored } = store();
    await (await built(s))(turn);
    expect(stored.map(({ id: _id, ...m }) => m)).toEqual([
      { userId: "static:alice", sessionKey: "http:alice:c1", role: "user", content: "What's open on KAN?", turnId: "t1", timestamp: "2026-11-13T10:00:00.000Z" },
      {
        userId: "static:alice",
        sessionKey: "http:alice:c1",
        role: "assistant",
        content: "Two issues.",
        displays: ["- KAN-1"],
        turnId: "t1",
        timestamp: "2026-11-13T10:00:05.000Z",
      },
    ]);
    expect(stored.map((m) => m.id)).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(stored[0]!.id).not.toBe(stored[1]!.id);
  });

  it("keeps how a confirmation was resolved", async () => {
    const { s, stored } = store();
    await (await built(s))({
      sessionKey: "s",
      person: { key: "static:alice" },
      operator: false,
      as: "anyone",
      kind: "confirmation",
      content: "Confirmed and done.",
      confirmation: { id: "c1", status: "ok" },
      at: "2026-11-13T10:01:00.000Z",
    });
    expect(stored.map(({ id: _id, ...m }) => m)).toEqual([
      { userId: "static:alice", sessionKey: "s", role: "assistant", content: "Confirmed and done.", confirmation: { id: "c1", status: "ok" }, timestamp: "2026-11-13T10:01:00.000Z" },
    ]);
  });

  // The operator (the terminal) holds the container: nothing of theirs is kept, as before.
  it("keeps nothing of the operator's", async () => {
    const { s, stored } = store();
    await (await built(s))({ ...turn, operator: true });
    expect(stored).toEqual([]);
  });

  it("keeps nothing of a failed turn", async () => {
    const { s, stored } = store();
    const { answer: _a, ...failed } = turn;
    await (await built(s))({ ...failed, outcome: "failed" });
    expect(stored).toEqual([]);
  });

  // The core logs a hook that rejects and traces it as a failed plugin.hook.
  it("rejects when the store does", async () => {
    const { s } = store(new Error("qdrant down"));
    await expect((await built(s))(turn)).rejects.toThrow("qdrant down");
  });
});
