import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, type ConversationStore, type PluginRuntimeContext, type StoredMessage, type ToolLog } from "@mercury-fw/plugin-types";
import { conversationWindow } from "./index.ts";

/** A store holding `messages` of alice's conversation `c1`, newest first as a `desc` read gets them; `fail` makes reads reject. */
function storeOf(messages: Array<Partial<StoredMessage>>, fail?: Error) {
  const reads: unknown[] = [];
  const store = {
    messages: async (q: unknown) => {
      reads.push(q);
      if (fail) throw fail;
      return { messages: [...messages].reverse() as StoredMessage[] };
    },
  } as unknown as ConversationStore;
  return { store, reads };
}

const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;
const archived = (role: "user" | "assistant", content: string, minute: number): Partial<StoredMessage> => ({
  id: `m${minute}`,
  userId: "static:alice",
  sessionKey: "c1",
  role,
  content,
  timestamp: at(minute),
});

/** What the plugin's `build` gets: the store and tool log given, a log collected in `logs`. */
function ctxWith(opts: { store?: ConversationStore; toolLog?: ToolLog } = {}) {
  const logs: string[] = [];
  const ctx = {
    model: {} as never,
    log: (m: string) => logs.push(m),
    ...(opts.store === undefined ? {} : { conversations: opts.store }),
    ...(opts.toolLog === undefined ? {} : { toolLog: opts.toolLog }),
  } as unknown as PluginRuntimeContext;
  return { ctx, logs };
}

/** The plugin's contributions built on `ctx`. */
async function built(plugin: ReturnType<typeof conversationWindow>, ctx: PluginRuntimeContext) {
  return await plugin.build!(ctx);
}

describe("conversationWindow", () => {
  it("is a plugin keeping conversations, acting as no one, asking for the conversation store to reopen them", () => {
    const plugin = conversationWindow();
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("conversation-window");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.needs).toEqual(["conversationStore"]);
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.systemPromptFragment).toContain("recall_tool_calls");
  });

  it("asks for nothing when it never reopens a conversation", () => {
    expect(conversationWindow({ reopen: false }).needs).toEqual([]);
  });

  it("refuses a size or a budget that can't be, at once", () => {
    for (const maxChars of [0, -1, 1.5]) expect(() => conversationWindow({ maxChars })).toThrow("conversationWindow: maxChars must be a whole number above 0");
    for (const maxChars of [-1, 1.5]) {
      expect(() => conversationWindow({ reopen: { maxChars } })).toThrow("conversationWindow: reopen.maxChars must be a whole number from 0 up");
    }
  });

  it("opens an empty window for a conversation not reopened, without reading the archive", async () => {
    const { store, reads } = storeOf([archived("user", "old", 0)]);
    const { ctx } = ctxWith({ store });
    const owner = (await built(conversationWindow(), ctx)).conversation!;
    const conversation = await owner.open({ sessionKey: "c1", person: { key: "static:alice" } });
    expect(conversation.getMessages()).toEqual([]);
    await conversation.addUserMessage("hi");
    expect(conversation.getMessages()).toEqual([{ role: "user", content: "hi" }]);
    expect(reads).toEqual([]);
  });

  it("shortens past the size it was given, as it was told to", async () => {
    const owner = (await built(conversationWindow({ maxChars: 10, overflow: "truncate" }), ctxWith().ctx)).conversation!;
    const conversation = await owner.open({ sessionKey: "c1" });
    await conversation.addUserMessage("12345");
    await conversation.addAssistantMessage("12345");
    expect(await conversation.addUserMessage("x")).toEqual({ messages: 2, charsBefore: 10, charsAfter: 0, durationMs: 0, outcome: "done" });
    expect(conversation.getMessages()).toEqual([{ role: "user", content: "x" }]);
  });

  it("brings a reopened conversation back from the archive, the person's messages stamped in the turn's time zone, none of it capturable", async () => {
    const { store, reads } = storeOf([archived("user", "colore?", 0), archived("assistant", "verde", 1)]);
    const { ctx, logs } = ctxWith({ store });
    const owner = (await built(conversationWindow(), ctx)).conversation!;
    const conversation = await owner.open({ sessionKey: "c1", person: { key: "static:alice" }, reopen: {}, timeZone: "Europe/Rome" });
    expect(reads).toEqual([{ userId: "static:alice", sessionKey: "c1", order: "desc", limit: 200 }]);
    expect(conversation.getMessages()).toEqual([
      { role: "user", content: "[Friday 2026-11-13 11:00 Europe/Rome]\ncolore?" },
      { role: "assistant", content: "verde" },
    ]);
    expect(conversation.getCapturable!()).toEqual([]);
    expect(logs).toEqual(["[conversation-window] resumed c1: 2 messages, no summary"]);
  });

  it("reopens within the channel's budget, else half of its own size", async () => {
    const messages = [archived("user", "a".repeat(6), 0), archived("assistant", "b".repeat(6), 1), archived("user", "c".repeat(6), 2), archived("assistant", "d".repeat(6), 3)];
    const open = async (opts: Parameters<typeof conversationWindow>[0], reopen: { maxChars?: number }) => {
      const owner = (await built(conversationWindow(opts), ctxWith({ store: storeOf(messages).store }).ctx)).conversation!;
      return (await owner.open({ sessionKey: "c1", person: { key: "static:alice" }, reopen })).getMessages().map((m) => m.content[0]);
    };
    expect(await open({ maxChars: 24 }, {})).toEqual(["c", "d"]);
    expect(await open({ maxChars: 24, reopen: { maxChars: 24 } }, {})).toEqual(["a", "b", "c", "d"]);
    expect(await open({}, { maxChars: 12 })).toEqual(["c", "d"]);
    expect(await open({}, { maxChars: 0 })).toEqual([]);
  });

  it("takes the summary of what the tail leaves out from what it was given to read them with", async () => {
    const messages = [archived("user", "a".repeat(60), 0), archived("assistant", "b".repeat(60), 1), archived("user", "c".repeat(10), 2), archived("assistant", "d".repeat(10), 3)];
    const asked: unknown[] = [];
    const earlier = { summariesOf: async (q: { person: string; sessionKey: string }) => (asked.push(q), [{ summary: "they talked about a and b", timestamp: at(1) }]) };
    const owner = (await built(conversationWindow({ earlier }), ctxWith({ store: storeOf(messages).store }).ctx)).conversation!;
    const conversation = await owner.open({ sessionKey: "c1", person: { key: "static:alice" }, reopen: { maxChars: 60 } });
    expect(asked).toEqual([{ person: "static:alice", sessionKey: "c1" }]);
    expect(conversation.getMessages()).toEqual([
      { role: "assistant", content: "Earlier conversation summary: they talked about a and b" },
      { role: "user", content: "c".repeat(10) },
      { role: "assistant", content: "d".repeat(10) },
    ]);
  });

  it("never reads the archive for someone nobody vouched for, nor when told never to reopen", async () => {
    const { store, reads } = storeOf([archived("user", "old", 0)]);
    const anonymous = (await built(conversationWindow(), ctxWith({ store }).ctx)).conversation!;
    expect((await anonymous.open({ sessionKey: "c1", reopen: {} })).getMessages()).toEqual([]);
    const never = (await built(conversationWindow({ reopen: false }), ctxWith({ store }).ctx)).conversation!;
    expect((await never.open({ sessionKey: "c1", person: { key: "static:alice" }, reopen: {} })).getMessages()).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("starts empty when the archive can't be read, saying so", async () => {
    const { ctx, logs } = ctxWith({ store: storeOf([], new Error("store away")).store });
    const owner = (await built(conversationWindow(), ctx)).conversation!;
    expect((await owner.open({ sessionKey: "c1", person: { key: "static:alice" }, reopen: {} })).getMessages()).toEqual([]);
    expect(logs).toEqual(["[conversation-window] couldn't resume c1, it starts without its earlier messages: Error: store away"]);
  });

  it("gives the turn recall_tool_calls over the core's tool log, for the turn's person and session, with its status", async () => {
    const asked: unknown[] = [];
    const toolLog: ToolLog = { read: (q) => (asked.push(q), []) };
    const contributions = await built(conversationWindow(), ctxWith({ toolLog }).ctx);
    const tools = contributions.sessionTools!({ sessionKey: "c1", person: { key: "static:alice" } } as never);
    expect(Object.keys(tools)).toEqual(["recall_tool_calls"]);
    await tools.recall_tool_calls!.execute!({}, {} as never);
    expect(asked).toEqual([{ person: "static:alice", sessionKey: "c1" }]);
    expect(contributions.toolStatusDescribers!.recall_tool_calls!({}, (key) => key)).toBe("conversation-window.status.recall");
    expect(conversationWindow().messages!["conversation-window.status.recall"]).toBe("Checking my memory…");
  });
});
