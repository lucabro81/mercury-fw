/**
 * The __TITLE__ strategy as the core uses it: a conversation per session, kept
 * apart and forgotten when the session closes, and optional methods that
 * change nothing of what the model reads.
 */
import { describe, expect, test } from "bun:test";
import type { ConversationOwner, PluginRuntimeContext } from "@mercury-fw/kit";
import { __EXPORT__ } from "./index.ts";

const ctx: PluginRuntimeContext = { model: {} as never, env: {}, log: () => {} };

/** The conversations the strategy keeps. */
async function owner(maxChars?: number): Promise<ConversationOwner> {
  const built = await __EXPORT__(maxChars === undefined ? {} : { maxChars }).build!(ctx);
  return built.conversation!;
}

describe("__NAME__", () => {
  test("keeps what each session said, apart", async () => {
    const conversations = await owner();
    const one = await conversations.open({ sessionKey: "s1" });
    const two = await conversations.open({ sessionKey: "s2" });
    await one.addUserMessage("hello", "[Monday]");
    await one.addAssistantMessage("hi", [{ toolName: "t", input: {}, result: { ok: true, ran: "t" } }]);
    expect(one.getMessages()).toEqual([
      { role: "user", content: "hello", context: "[Monday]" },
      { role: "assistant", content: "hi", calls: [{ toolName: "t", input: {}, result: { ok: true, ran: "t" } }] },
    ]);
    expect(two.getMessages()).toEqual([]);
    expect(one.getCharCount()).toBe(15);
  });

  test("reports what it dropped to stay within its size", async () => {
    const conversation = await (await owner(10)).open({ sessionKey: "s1" });
    await conversation.addUserMessage("aaaaaaaa");
    expect(await conversation.addAssistantMessage("bbbbbbbb")).toMatchObject({ messages: 1, outcome: "done" });
  });

  test("starts a session over once it closed", async () => {
    const conversations = await owner();
    const first = await conversations.open({ sessionKey: "s1" });
    await first.addUserMessage("hello");
    conversations.close?.("s1");
    expect((await conversations.open({ sessionKey: "s1" })).getMessages()).toEqual([]);
  });

  test("leaves tool outputs, past calls and layers as the core shows them", async () => {
    const conversation = await (await owner()).open({ sessionKey: "s1" });
    const layers = { session: [{ layer: "wiki", blocks: ["index"] }] };
    expect(await conversation.toolOutput?.({ toolName: "t", toolCallId: "1", input: {} }, { rows: 3 })).toBeUndefined();
    expect(conversation.pastCall?.({ toolName: "t", input: {}, result: { ok: true, ran: "t" } }, { ok: true })).toEqual({ ok: true });
    expect(await conversation.turnIndex?.()).toBeUndefined();
    expect(await conversation.placeLayers?.(layers)).toBe(layers);
  });

  test("refuses a size that isn't one", () => {
    expect(() => __EXPORT__({ maxChars: 0 })).toThrow("__NAME__: maxChars is a whole number of characters, at least 1 (got 0)");
  });
});
