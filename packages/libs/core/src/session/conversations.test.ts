import { describe, expect, it } from "bun:test";
import type { Conversation, ConversationOpen, ConversationOwner } from "@mercury-fw/plugin-types";
import type { TurnWho } from "../identity/people.ts";
import { createConversations } from "./conversations.ts";
import { createSessionHistory, type SessionHistory } from "./history.ts";

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

/** The internal window, recording the requests it's built for. */
function internalWindow() {
  const built: unknown[] = [];
  return {
    built,
    internal: async (req: unknown): Promise<SessionHistory> => (built.push(req), createSessionHistory(async () => "summary")),
  };
}

describe("createConversations", () => {
  it("opens a session's conversation with the plugin of its first person's profile, once, and keeps it", async () => {
    const { owner, opened } = recordingOwner();
    const { internal, built } = internalWindow();
    const conversations = createConversations({ ownerFor: () => owner, internal, primerFor: async () => undefined });

    const first = await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice", resume: { maxChars: 500 }, timeZone: "Europe/Rome" });
    await first.addUserMessage("hi");
    const again = await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice" });

    expect(opened).toEqual([{ sessionKey: "s1", person: { key: "static:alice" }, reopen: { maxChars: 500 }, timeZone: "Europe/Rome" }]);
    expect(again.getMessages()).toEqual([{ role: "user", content: "hi" }]);
    expect(conversations.get("s1")).toBe(again);
    expect(built).toEqual([]);
  });

  it("opens it for no one when nobody vouched for who writes: nothing to bring back, nobody's to keep", async () => {
    const { owner, opened } = recordingOwner();
    const conversations = createConversations({ ownerFor: () => owner, internal: internalWindow().internal, primerFor: async () => undefined });
    await conversations.open(alice, { sessionKey: "terminal", tracked: false, resume: {}, timeZone: "UTC" });
    expect(opened).toEqual([{ sessionKey: "terminal" }]);
  });

  it("gives the plugin's conversation the primer of the person's earlier conversations, and the plugin's own capturable or its messages", async () => {
    const primer = { current: "INDEX", recap: "" };
    const asked: unknown[] = [];
    const conversations = createConversations({
      ownerFor: () => recordingOwner().owner,
      internal: internalWindow().internal,
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
      internal: internalWindow().internal,
      primerFor: async () => ({ current: "", recap: "" }),
    });
    expect((await conversations.open(alice, { sessionKey: "s1", tracked: true, userId: "static:alice" })).primer()).toBeUndefined();
    expect((await conversations.open(alice, { sessionKey: "s2", tracked: false })).primer()).toBeUndefined();
  });

  it("uses the internal window when the profile names no plugin, as before", async () => {
    const { internal, built } = internalWindow();
    const conversations = createConversations({ ownerFor: () => undefined, internal, primerFor: async () => undefined });
    const req = { sessionKey: "s1", tracked: true, userId: "static:alice", resume: { maxChars: 10 }, timeZone: "UTC" };
    await conversations.open(alice, req);
    await conversations.open(alice, req);
    expect(built).toEqual([req]);
  });

  it("closes a session: the plugin hears it, and the next turn opens a new conversation", async () => {
    const { owner, opened, closed } = recordingOwner();
    const conversations = createConversations({ ownerFor: () => owner, internal: internalWindow().internal, primerFor: async () => undefined });
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
      internal: internalWindow().internal,
      primerFor: async () => undefined,
    });
    await expect(conversations.open(alice, { sessionKey: "s1", tracked: false })).rejects.toThrow("store away");
    fail = false;
    expect(await conversations.open(alice, { sessionKey: "s1", tracked: false })).toBeDefined();
  });
});
