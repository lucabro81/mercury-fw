import { describe, expect, it } from "bun:test";
import type { CompressionReport, Conversation, ConversationOpen, ConversationOwner } from "@mercury-fw/plugin-types";
import type { TurnWho } from "../identity/people.ts";
import { createConversations } from "./conversations.ts";

const alice: TurnWho = { person: { key: "static:alice", roles: [] }, operator: false };

/** A conversation keeping its messages in an array. */
function memoryConversation(): Conversation {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  return {
    getMessages: () => [...messages],
    addUserMessage: async (content) => void messages.push({ role: "user", content }),
    addAssistantMessage: async (content) => void messages.push({ role: "assistant", content }),
    replaceLastAssistantMessage: (content) => {
      messages[messages.length - 1] = { role: "assistant", content };
    },
    getCharCount: () => messages.reduce((n, m) => n + m.content.length, 0),
  };
}

/** An owner that records what it's asked to open and close. */
function recordingOwner() {
  const opened: ConversationOpen[] = [];
  const closed: string[] = [];
  const owner: ConversationOwner = {
    open: async (req) => (opened.push(req), memoryConversation()),
    close: (sessionKey) => void closed.push(sessionKey),
  };
  return { owner, opened, closed };
}

describe("createConversations", () => {
  it("opens a session's conversation with the plugin of its first person's profile, once, and keeps it", async () => {
    const { owner, opened } = recordingOwner();
    const conversations = createConversations({ ownerFor: () => owner, primerFor: async () => undefined });

    const first = await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice", resume: { maxChars: 500 }, timeZone: "Europe/Rome" });
    await first.addUserMessage("hi");
    const again = await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice" });

    expect(opened).toEqual([{ sessionKey: "s1", person: { key: "static:alice" }, reopen: { maxChars: 500 }, timeZone: "Europe/Rome" }]);
    expect(again.getMessages()).toEqual([{ role: "user", content: "hi" }]);
    expect(conversations.get("s1")).toBe(again);
  });

  it("opens it for no one when nobody vouched for who writes: nothing to bring back, nobody's to keep", async () => {
    const { owner, opened } = recordingOwner();
    const conversations = createConversations({ ownerFor: () => owner, primerFor: async () => undefined });
    await conversations.open(alice, { sessionKey: "terminal", tracked: false, resume: {}, timeZone: "UTC" });
    expect(opened).toEqual([{ sessionKey: "terminal" }]);
  });

  it("gives the plugin's conversation the primer of the person's earlier conversations, and the plugin's own capturable or its messages", async () => {
    const primer = { current: "INDEX" };
    const asked: unknown[] = [];
    const conversations = createConversations({
      ownerFor: () => recordingOwner().owner,
      primerFor: async (userId, reopen) => (asked.push([userId, reopen]), primer),
    });
    const history = await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice", resume: {} });
    await history.addUserMessage("hi");
    expect(history.primer()).toEqual(primer);
    expect(history.getCapturable()).toEqual([{ role: "user", content: "hi" }]);
    expect(asked).toEqual([["static:alice", {}]]);
  });

  it("has no primer when it's empty, or for a turn nobody vouched for", async () => {
    const conversations = createConversations({
      ownerFor: () => recordingOwner().owner,
      primerFor: async () => ({ current: "" }),
    });
    expect((await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice" })).primer()).toBeUndefined();
    expect((await conversations.open(alice, { sessionKey: "s2", tracked: false })).primer()).toBeUndefined();
  });

  it("opens the conversation without a primer when the primer fails: the plugin's conversation is kept, never left open and unknown", async () => {
    const { owner, opened } = recordingOwner();
    const logs: string[] = [];
    const conversations = createConversations({
      ownerFor: () => owner,
      primerFor: async () => Promise.reject(new Error("index away")),
      log: (m) => logs.push(m),
    });
    const history = await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice" });
    expect(history.primer()).toBeUndefined();
    expect(conversations.get("s1")).toBe(history);
    expect(opened.length).toBe(1);
    expect(logs).toEqual(["[memory] the primer failed, the conversation starts without: index away"]);
  });

  it("keeps no conversation when the profile names no plugin: each turn sees only what it adds, while all of it stays capturable", async () => {
    const conversations = createConversations({ ownerFor: () => undefined, primerFor: async () => ({ current: "INDEX" }) });
    const history = await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice" });
    await history.addUserMessage("first", "CTX");
    await history.addAssistantMessage("one", [{ toolName: "t", input: {}, result: { ok: true, ran: "t" } }]);
    expect(history.getMessages()).toEqual([
      { role: "user", content: "first", context: "CTX" },
      { role: "assistant", content: "one", calls: [{ toolName: "t", input: {}, result: { ok: true, ran: "t" } }] },
    ]);
    await history.addUserMessage("second");
    expect(history.getMessages()).toEqual([{ role: "user", content: "second" }]);
    await history.addAssistantMessage("two");
    history.replaceLastAssistantMessage("two, fixed");
    expect(history.getMessages()).toEqual([
      { role: "user", content: "second" },
      { role: "assistant", content: "two, fixed" },
    ]);
    expect(history.getCharCount()).toBe("second".length + "two, fixed".length);
    expect(history.getCapturable().map((m) => m.content)).toEqual(["first", "one", "second", "two, fixed"]);
    expect(history.primer()).toEqual({ current: "INDEX" });
    expect(await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice" })).toBe(history);
  });

  it("tells what a compression did, for the session, when the conversation reports one; nothing for an add that didn't compress", async () => {
    const report: CompressionReport = { messages: 4, charsBefore: 900, charsAfter: 80, durationMs: 12, outcome: "done" };
    const failed: CompressionReport = { messages: 2, charsBefore: 300, durationMs: 3, outcome: "failed", error: "model away" };
    const reports = [undefined, report, failed];
    const conversation: Conversation = {
      ...memoryConversation(),
      addUserMessage: async () => reports.shift(),
      addAssistantMessage: async () => reports.shift(),
    };
    const told: Array<[string, CompressionReport]> = [];
    const conversations = createConversations({
      ownerFor: () => ({ open: async () => conversation }),
      primerFor: async () => undefined,
      onCompressed: (sessionKey, r) => void told.push([sessionKey, r]),
    });
    const history = await conversations.open(alice, { sessionKey: "s1", tracked: false });
    await history.addUserMessage("a");
    await history.addAssistantMessage("b");
    await history.addUserMessage("c");
    expect(told).toEqual([
      ["s1", report],
      ["s1", failed],
    ]);
  });

  it("closes a session: the plugin hears it, and the next turn opens a new conversation", async () => {
    const { owner, opened, closed } = recordingOwner();
    const conversations = createConversations({ ownerFor: () => owner, primerFor: async () => undefined });
    await conversations.open(alice, { sessionKey: "s1", tracked: false });
    conversations.close("s1");
    conversations.close("never-opened");
    expect(conversations.get("s1")).toBeUndefined();
    await conversations.open(alice, { sessionKey: "s1", tracked: false });
    expect(closed).toEqual(["s1"]);
    expect(opened.length).toBe(2);
  });

  it("keeps nothing of an opening that failed: the next turn tries again", async () => {
    let fail = true;
    const conversations = createConversations({
      ownerFor: () => ({ open: async () => (fail ? Promise.reject(new Error("store away")) : memoryConversation()) }),
      primerFor: async () => undefined,
    });
    await expect(conversations.open(alice, { sessionKey: "s1", tracked: false })).rejects.toThrow("store away");
    fail = false;
    expect(await conversations.open(alice, { sessionKey: "s1", tracked: false })).toBeDefined();
  });

  it("a compression the trace can't record is only logged: the turn goes on", async () => {
    const logs: string[] = [];
    const conversations = createConversations({
      ownerFor: () => ({ open: async () => ({ ...memoryConversation(), addUserMessage: async () => ({ messages: 1, charsBefore: 1, durationMs: 0, outcome: "done" as const }) }) }),
      primerFor: async () => undefined,
      onCompressed: () => {
        throw new Error("sink away");
      },
      log: (m) => logs.push(m),
    });
    const history = await conversations.open(alice, { sessionKey: "s1", tracked: false });
    await history.addUserMessage("a");
    expect(logs).toEqual(["[conversation] the compression of s1 wasn't recorded: sink away"]);
  });
});
