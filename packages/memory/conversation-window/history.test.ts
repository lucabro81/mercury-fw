import { describe, it, expect } from "bun:test";
import type { CallRecord } from "@mercury-fw/plugin-types";
import { createWindow, DEFAULT_MAX_CHARS as MAX_HISTORY_CHARS, type Message, type ResumedConversation } from "./history.ts";

/** A window summarizing with `summarize`, opened on `resumed` when given. */
function createSessionHistory(summarize: (messages: Message[]) => Promise<string>, resumed?: ResumedConversation) {
  return createWindow(resumed === undefined ? { summarize } : { summarize, resumed });
}

function fakeSummarizer(spy?: { calls: Message[][] }) {
  return async (messages: Message[]): Promise<string> => {
    spy?.calls.push(messages);
    return "a summary";
  };
}

describe("createWindow", () => {
  it("returns an empty array when nothing was added", () => {
    const history = createSessionHistory(fakeSummarizer());
    expect(history.getMessages()).toEqual([]);
  });

  it("returns messages in order after adding a user and an assistant message", async () => {
    const history = createSessionHistory(fakeSummarizer());
    await history.addUserMessage("hi");
    await history.addAssistantMessage("hello");
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("never calls summarize while under the threshold", async () => {
    const calls: Message[][] = [];
    const history = createSessionHistory(fakeSummarizer({ calls }));
    await history.addUserMessage("short message");
    await history.addAssistantMessage("another short message");
    expect(calls.length).toBe(0);
  });

  // Uses a realistic multi-message trigger (prior context + a crossing user
  // turn) rather than a lone oversized message: since bug #19's fix the
  // crossing user turn is retained, not summarized, so the batch is exactly
  // the context preceding it.
  it("summarizes exactly once when an append crosses the threshold, over the context preceding the retained user turn", async () => {
    const calls: Message[][] = [];
    const history = createSessionHistory(fakeSummarizer({ calls }));
    const filler = "x".repeat(MAX_HISTORY_CHARS); // at the boundary, no trigger
    await history.addAssistantMessage(filler);
    await history.addUserMessage("latest question"); // crosses → compresses the filler, retains this turn

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([{ role: "assistant", content: filler }]);
  });

  it("boundary: exactly MAX_HISTORY_CHARS does not trigger, +1 does", async () => {
    const callsAtBoundary: Message[][] = [];
    const atBoundary = createSessionHistory(fakeSummarizer({ calls: callsAtBoundary }));
    await atBoundary.addUserMessage("x".repeat(MAX_HISTORY_CHARS));
    expect(callsAtBoundary.length).toBe(0);

    const callsOverBoundary: Message[][] = [];
    const overBoundary = createSessionHistory(
      fakeSummarizer({ calls: callsOverBoundary }),
    );
    // Assistant filler sits at the boundary; a following user turn tips it one
    // char past MAX, so there is preceding context to compress.
    await overBoundary.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
    await overBoundary.addUserMessage("x");
    expect(callsOverBoundary.length).toBe(1);
  });

  it("keeps the summary alongside new raw messages after a summarization happens", async () => {
    const history = createSessionHistory(fakeSummarizer());
    await history.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
    await history.addUserMessage("first question after fill"); // triggers compression, retains this turn

    // The compressed context became a summary; the current user turn was
    // retained live alongside it (bug #19: never summarized away).
    const afterSummary = history.getMessages();
    expect(afterSummary.length).toBe(2);
    expect(afterSummary[0]?.content).toContain("a summary");
    expect(afterSummary[1]).toEqual({ role: "user", content: "first question after fill" });

    await history.addAssistantMessage("an answer");
    const messages = history.getMessages();
    expect(messages.length).toBe(3);
    expect(messages[0]?.content).toContain("a summary");
    expect(messages[1]).toEqual({ role: "user", content: "first question after fill" });
    expect(messages[2]).toEqual({ role: "assistant", content: "an answer" });
  });

  // Lets the terminal show a live "how full is the context" indicator
  // (see src/router/terminal.ts's promptSuffix) — useful for telling
  // apart "the model is confused" from "the context is actually full".
  it("getCharCount reports the total length of what getMessages() would return", async () => {
    const history = createSessionHistory(fakeSummarizer());
    expect(history.getCharCount()).toBe(0);

    await history.addUserMessage("hi"); // 2 chars
    await history.addAssistantMessage("hello"); // 5 chars
    expect(history.getCharCount()).toBe(7);
  });

  it("getCharCount counts the summary message's length after a summarization happens", async () => {
    const history = createSessionHistory(fakeSummarizer());
    await history.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
    await history.addUserMessage("latest"); // triggers compression → a summary now leads getMessages()

    const messages = history.getMessages();
    const expected = messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(history.getCharCount()).toBe(expected);
  });

  // Regression guard for bug #19: on a long conversation, the append that
  // crosses the threshold used to clear the ENTIRE raw history — including the
  // current user turn when it was the message that tipped it over. Since the
  // summary leading message is role:"assistant",
  // getMessages() then had no role:"user" at all, and Ollama rejects that
  // array with "no user query found in messages". Compression must always
  // retain at least the current user turn.
  describe("bug #19: the current user turn survives compression", () => {
    it("keeps a role:'user' message (the latest turn) after a user append triggers compression", async () => {
      const history = createSessionHistory(fakeSummarizer());
      // Prior context sits at the boundary without triggering; the next user
      // turn tips it over — exactly the runTurn() sequence (addUserMessage
      // then getMessages()) that surfaced the bug live.
      await history.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
      await history.addUserMessage("what's the status of MER-1?");

      const messages = history.getMessages();
      expect(messages.some((m) => m.role === "user")).toBe(true);
      expect(messages[messages.length - 1]).toEqual({
        role: "user",
        content: "what's the status of MER-1?",
      });
    });

    it("keeps the user turn after a second compression too (the summary alone is the assistant's)", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
      await history.addUserMessage("and MER-1?");
      await history.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
      await history.addUserMessage("and MER-2?");

      const messages = history.getMessages();
      expect(messages.some((m) => m.role === "user")).toBe(true);
      expect(messages[messages.length - 1]).toEqual({ role: "user", content: "and MER-2?" });
    });

    it("leaves a lone oversized user message live and does not summarize it away", async () => {
      const calls: Message[][] = [];
      const history = createSessionHistory(fakeSummarizer({ calls }));
      const big = "x".repeat(MAX_HISTORY_CHARS + 1);
      await history.addUserMessage(big);

      // Nothing precedes the current turn, so there is nothing to compress:
      // the user's question stays verbatim rather than being summarized away.
      expect(calls.length).toBe(0);
      expect(history.getMessages()).toEqual([{ role: "user", content: big }]);
    });
  });

  // #393: the window is a plugin, so it tells the core what each compression
  // did (the history.compressed event) instead of the core timing it.
  describe("the compression report", () => {
    it("says how many messages were folded, their length, the summary's and how long it took", async () => {
      let clock = 0;
      const filler = "x".repeat(MAX_HISTORY_CHARS);
      const history = createWindow({
        summarize: async () => {
          clock += 1_200;
          return "a summary";
        },
        now: () => clock,
      });
      expect(await history.addAssistantMessage(filler)).toBeUndefined();
      expect(await history.addUserMessage("latest")).toEqual({
        messages: 1,
        charsBefore: MAX_HISTORY_CHARS,
        charsAfter: "a summary".length,
        durationMs: 1_200,
        outcome: "done",
      });
    });

    it("counts the prior summary as one of the messages folded again", async () => {
      const calls: Message[][] = [];
      const filler = "x".repeat(MAX_HISTORY_CHARS);
      const history = createSessionHistory(fakeSummarizer({ calls }));
      await history.addAssistantMessage(filler);
      await history.addUserMessage("first");
      await history.addAssistantMessage("an answer");
      const report = await history.addUserMessage(filler);
      expect(calls[1]?.[0]).toEqual({ role: "assistant", content: "Earlier conversation summary: a summary" });
      expect(report).toEqual(expect.objectContaining({ messages: 3, outcome: "done" }));
    });

    it("a summary that fails leaves the window as it was, says so, and the next message tries again", async () => {
      let failing = true;
      const filler = "x".repeat(MAX_HISTORY_CHARS);
      const history = createWindow({
        summarize: async () => {
          if (failing) throw new Error("model away");
          return "a summary";
        },
        now: () => 0,
      });
      await history.addAssistantMessage(filler);
      expect(await history.addUserMessage("latest")).toEqual({
        messages: 1,
        charsBefore: MAX_HISTORY_CHARS,
        durationMs: 0,
        outcome: "failed",
        error: "model away",
      });
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: filler },
        { role: "user", content: "latest" },
      ]);
      failing = false;
      expect(await history.addAssistantMessage("an answer")).toEqual(expect.objectContaining({ outcome: "done", messages: 1 }));
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "Earlier conversation summary: a summary" },
        { role: "user", content: "latest" },
        { role: "assistant", content: "an answer" },
      ]);
    });
  });

  describe("maxChars", () => {
    it("shortens past the size it was given instead of the default", async () => {
      const calls: Message[][] = [];
      const history = createWindow({ summarize: fakeSummarizer({ calls }), maxChars: 10 });
      await history.addUserMessage("12345");
      await history.addAssistantMessage("12345");
      expect(calls).toHaveLength(0);
      await history.addUserMessage("x");
      expect(calls).toEqual([
        [
          { role: "user", content: "12345" },
          { role: "assistant", content: "12345" },
        ],
      ]);
    });
  });

  describe("truncate", () => {
    it("drops the oldest messages until the window fits, opening it with what the person said, and never calls the model", async () => {
      const calls: Message[][] = [];
      const history = createWindow({ summarize: fakeSummarizer({ calls }), maxChars: 20, overflow: "truncate" });
      await history.addUserMessage("aaaaa");
      await history.addAssistantMessage("bbbbb");
      await history.addUserMessage("ccccc");
      await history.addAssistantMessage("ddddd");
      // 25 characters: dropping "aaaaa" would fit, but the window would open with an answer.
      const report = await history.addUserMessage("eeeee");
      expect(calls).toHaveLength(0);
      expect(history.getMessages()).toEqual([
        { role: "user", content: "ccccc" },
        { role: "assistant", content: "ddddd" },
        { role: "user", content: "eeeee" },
      ]);
      expect(report).toEqual({ messages: 2, charsBefore: 10, charsAfter: 0, durationMs: 0, outcome: "done" });
    });

    it("never drops the current turn: a turn alone past the size stays whole", async () => {
      const history = createWindow({ summarize: fakeSummarizer(), maxChars: 5, overflow: "truncate" });
      await history.addUserMessage("a long question");
      expect(await history.addAssistantMessage("a long answer")).toBeUndefined();
      expect(history.getMessages()).toEqual([
        { role: "user", content: "a long question" },
        { role: "assistant", content: "a long answer" },
      ]);
    });

    it("drops a reopened conversation's messages like any other, leaving what's new capturable", async () => {
      const history = createWindow({
        summarize: fakeSummarizer(),
        maxChars: 12,
        overflow: "truncate",
        resumed: { messages: [{ role: "user", content: "old q" }, { role: "assistant", content: "old a" }] },
      });
      await history.addUserMessage("new q");
      expect(history.getMessages()).toEqual([{ role: "user", content: "new q" }]);
      expect(history.getCapturable()).toEqual([{ role: "user", content: "new q" }]);
    });
  });

  // Used by turn-runner.ts to persist a corrected assistant turn (see
  // issue-list correction) after it was already recorded — without this,
  // the duplicated-list version the feature exists to eliminate would
  // permanently survive in the model's own future context.
  describe("replaceLastAssistantMessage", () => {
    it("overwrites the last message's content when it's an assistant message", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addUserMessage("hi");
      await history.addAssistantMessage("raw duplicated list");

      history.replaceLastAssistantMessage("corrected text");

      expect(history.getMessages()).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "corrected text" },
      ]);
    });

    it("no-ops when there are no messages yet", () => {
      const history = createSessionHistory(fakeSummarizer());
      history.replaceLastAssistantMessage("corrected text");
      expect(history.getMessages()).toEqual([]);
    });

    it("no-ops when the last message is a user message", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addAssistantMessage("hello");
      await history.addUserMessage("what about MER-1?");

      history.replaceLastAssistantMessage("corrected text");

      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "hello" },
        { role: "user", content: "what about MER-1?" },
      ]);
    });

    it("does not call summarize, even when the replacement alone would exceed MAX_HISTORY_CHARS", async () => {
      const calls: Message[][] = [];
      const history = createSessionHistory(fakeSummarizer({ calls }));
      await history.addAssistantMessage("short");

      history.replaceLastAssistantMessage("x".repeat(MAX_HISTORY_CHARS + 1));

      expect(calls.length).toBe(0);
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "x".repeat(MAX_HISTORY_CHARS + 1) },
      ]);
    });
  });

  describe("resumed (#163)", () => {
    const resumed = {
      summary: "they said their favourite colour is green",
      messages: [
        { role: "user" as const, content: "and the car?" },
        { role: "assistant" as const, content: "a red one" },
      ],
    };

    it("leads the history with the resumed summary and messages", () => {
      const history = createSessionHistory(fakeSummarizer(), resumed);
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "Earlier conversation summary: they said their favourite colour is green" },
        { role: "user", content: "and the car?" },
        { role: "assistant", content: "a red one" },
      ]);
    });

    it("leaves the resumed part out of what's capturable, keeping what's new", async () => {
      const history = createSessionHistory(fakeSummarizer(), resumed);
      expect(history.getCapturable()).toEqual([]);
      await history.addUserMessage("and the bike?");
      await history.addAssistantMessage("blue");
      expect(history.getCapturable()).toEqual([
        { role: "user", content: "and the bike?" },
        { role: "assistant", content: "blue" },
      ]);
    });

    it("without a summary, only the messages are resumed", () => {
      const history = createSessionHistory(fakeSummarizer(), { messages: resumed.messages });
      expect(history.getMessages()).toEqual(resumed.messages);
      expect(history.getCapturable()).toEqual([]);
    });

    it("a compression summarizes the resumed part too, and then everything is capturable", async () => {
      const calls: Message[][] = [];
      const history = createSessionHistory(fakeSummarizer({ calls }), resumed);
      await history.addUserMessage("x".repeat(10));
      await history.addAssistantMessage("y".repeat(10));
      await history.addUserMessage("z".repeat(MAX_HISTORY_CHARS));

      expect(calls).toEqual([
        [
          { role: "assistant", content: "Earlier conversation summary: they said their favourite colour is green" },
          { role: "user", content: "and the car?" },
          { role: "assistant", content: "a red one" },
          { role: "user", content: "x".repeat(10) },
          { role: "assistant", content: "y".repeat(10) },
        ],
      ]);
      expect(history.getCapturable()).toEqual(history.getMessages());
    });

    it("a compression over the resumed part alone folds it into a new summary", async () => {
      const history = createSessionHistory(fakeSummarizer(), resumed);
      await history.addUserMessage("z".repeat(MAX_HISTORY_CHARS));
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "Earlier conversation summary: a summary" },
        { role: "user", content: "z".repeat(MAX_HISTORY_CHARS) },
      ]);
      expect(history.getCapturable()).toEqual(history.getMessages());
    });

    it("without resumed, getCapturable is getMessages", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addUserMessage("hi");
      expect(history.getCapturable()).toEqual(history.getMessages());
    });
  });
  // The calls are what later turns see of this one's tools: lost, the history
  // shows only plain-text answers and the model stops calling tools (#351, #352).
  describe("calls (#352)", () => {
    const calls: CallRecord[] = [
      { toolName: "confluenceCommand", input: { command: "confluence page comments 1102" }, result: { ok: true, ran: "confluence page comments 1102", results: 2 } },
    ];

    it("keeps an answer's tool calls with it, and leaves them off a message that had none", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addUserMessage("comments?");
      await history.addAssistantMessage("Two comments.", calls);
      await history.addUserMessage("thanks");
      await history.addAssistantMessage("You're welcome.", []);
      expect(history.getMessages()).toEqual([
        { role: "user", content: "comments?" },
        { role: "assistant", content: "Two comments.", calls },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "You're welcome." },
      ]);
    });

    it("keeps the calls when replaceLastAssistantMessage corrects the answer's text", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addUserMessage("comments?");
      await history.addAssistantMessage("Two comment.", calls);
      history.replaceLastAssistantMessage("Two comments.");
      expect(history.getMessages()[1]).toEqual({ role: "assistant", content: "Two comments.", calls });
    });

    it("counts the calls toward getCharCount", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addAssistantMessage("ok", calls);
      expect(history.getCharCount()).toBe(2 + JSON.stringify(calls).length);
    });

    it("summarizes when the calls are what crosses the threshold", async () => {
      const spy = { calls: [] as Message[][] };
      const history = createSessionHistory(fakeSummarizer(spy));
      // "q", the text and the calls land exactly on the threshold: the next message crosses it.
      const text = "x".repeat(MAX_HISTORY_CHARS - 1 - JSON.stringify(calls).length);
      await history.addUserMessage("q");
      await history.addAssistantMessage(text, calls);
      expect(spy.calls).toHaveLength(0);
      await history.addUserMessage("next");
      expect(spy.calls).toHaveLength(1);
    });
  });
});

// #387: the turn's context kept beside the person's message is what the
// model reads too, so it counts toward the history's size.
describe("createWindow: a message's context", () => {
  it("keeps the context apart from the message's text and counts it in the history's size", async () => {
    const history = createSessionHistory(async () => "summary");
    await history.addUserMessage("hello", "<context>\nfact\n</context>");
    expect(history.getMessages()).toEqual([{ role: "user", content: "hello", context: "<context>\nfact\n</context>" }]);
    expect(history.getCharCount()).toBe("hello".length + "<context>\nfact\n</context>".length);
  });
});
