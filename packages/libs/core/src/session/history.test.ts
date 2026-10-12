import { describe, it, expect } from "bun:test";
import { createSessionHistory, MAX_HISTORY_CHARS } from "./history.ts";
import type { Message } from "./history.ts";

function fakeSummarizer(spy?: { calls: Message[][] }) {
  return async (messages: Message[]): Promise<string> => {
    spy?.calls.push(messages);
    return "a summary";
  };
}

describe("createSessionHistory", () => {
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
  // primer and summary leading messages are both role:"assistant",
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

    it("keeps the user turn even with a primer set (primer + summary alone are both assistant)", async () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "prior session facts");
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

  // onBeforeCompress lets an episodic/semantic capture mirror a batch of
  // messages to Qdrant right before Layer 1 discards them from the live
  // context — see idle-session-cron.ts's shared capture function.
  describe("onBeforeCompress", () => {
    it("is called with exactly the batch about to be compressed, before summarize resolves", async () => {
      const seen: Message[][] = [];
      const filler = "x".repeat(MAX_HISTORY_CHARS);
      const history = createSessionHistory(fakeSummarizer(), (messages) => {
        seen.push(messages);
      });

      await history.addAssistantMessage(filler);
      await history.addUserMessage("latest"); // compresses the filler; retained user turn is excluded

      expect(seen).toEqual([[{ role: "assistant", content: filler }]]);
    });

    it("is never called while under the threshold", async () => {
      const seen: Message[][] = [];
      const history = createSessionHistory(fakeSummarizer(), (messages) => {
        seen.push(messages);
      });

      await history.addUserMessage("short message");
      expect(seen.length).toBe(0);
    });

    it("is optional — omitting it changes nothing about summarization behavior", async () => {
      const history = createSessionHistory(fakeSummarizer());
      await history.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
      await history.addUserMessage("latest");
      expect(history.getMessages()[0]?.content).toContain("a summary");
    });

    it("receives the prior summary re-injected as a leading message, same batch summarize() gets", async () => {
      const seen: Message[][] = [];
      const filler = "x".repeat(MAX_HISTORY_CHARS);
      const history = createSessionHistory(fakeSummarizer(), (messages) => {
        seen.push(messages);
      });

      // First compression: the filler is summarized, "first" retained.
      await history.addAssistantMessage(filler);
      await history.addUserMessage("first");
      // Second compression: a later oversized user turn crosses again, so the
      // prior summary + the intervening messages form the new batch.
      await history.addAssistantMessage("an answer");
      await history.addUserMessage(filler);

      expect(seen.length).toBe(2);
      expect(seen[1]?.[0]).toEqual({ role: "assistant", content: "Earlier conversation summary: a summary" });
    });
  });

  // The primer seeds a brand-new session with facts from the user's last
  // closed session (see context-primer.ts) — kept as state independent from
  // `summary` on purpose, so it's never at risk of being paraphrased or
  // dropped by the LLM summarizer (see history_primer design note).
  describe("primer", () => {
    it("seeds getMessages() with the primer as the leading message before any turn happens", () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "user is a data scientist");
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "Context from your last session: user is a data scientist" },
      ]);
    });

    it("orders the primer before the summary message once a real compression produces one", async () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "prior session facts");
      await history.addAssistantMessage("x".repeat(MAX_HISTORY_CHARS));
      await history.addUserMessage("latest");

      const messages = history.getMessages();
      expect(messages[0]).toEqual({
        role: "assistant",
        content: "Context from your last session: prior session facts",
      });
      expect(messages[1]?.content).toContain("a summary");
    });

    it("omitting the primer behaves exactly as before this change — no leading primer message", () => {
      const history = createSessionHistory(fakeSummarizer());
      expect(history.getMessages()).toEqual([]);
    });

    it("an empty-string primer behaves like an omitted one", () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "");
      expect(history.getMessages()).toEqual([]);
    });

    it("survives a real compression event unchanged — it is never part of the batch sent to summarize()", async () => {
      const calls: Message[][] = [];
      const filler = "x".repeat(MAX_HISTORY_CHARS);
      const history = createSessionHistory(fakeSummarizer({ calls }), undefined, "prior session facts");

      await history.addAssistantMessage(filler);
      await history.addUserMessage("latest");

      expect(calls).toEqual([[{ role: "assistant", content: filler }]]);
      expect(history.getMessages()[0]).toEqual({
        role: "assistant",
        content: "Context from your last session: prior session facts",
      });
    });

    it("getCharCount includes the primer's length once it's present", () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "hello");
      expect(history.getCharCount()).toBe("Context from your last session: hello".length);
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

    it("leads the history with the resumed summary and messages, after the primer", () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "primer", resumed);
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "Context from your last session: primer" },
        { role: "assistant", content: "Earlier conversation summary: they said their favourite colour is green" },
        { role: "user", content: "and the car?" },
        { role: "assistant", content: "a red one" },
      ]);
    });

    it("leaves the resumed part out of what's capturable, keeping what's new", async () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "primer", resumed);
      expect(history.getCapturable()).toEqual([{ role: "assistant", content: "Context from your last session: primer" }]);
      await history.addUserMessage("and the bike?");
      await history.addAssistantMessage("blue");
      expect(history.getCapturable()).toEqual([
        { role: "assistant", content: "Context from your last session: primer" },
        { role: "user", content: "and the bike?" },
        { role: "assistant", content: "blue" },
      ]);
    });

    it("without a summary, only the messages are resumed", () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, undefined, { messages: resumed.messages });
      expect(history.getMessages()).toEqual(resumed.messages);
      expect(history.getCapturable()).toEqual([]);
    });

    it("a compression summarizes the resumed part too, but mirrors only what's new, and then everything is capturable", async () => {
      const calls: Message[][] = [];
      const mirrored: Message[][] = [];
      const history = createSessionHistory(fakeSummarizer({ calls }), (batch) => mirrored.push(batch), undefined, resumed);
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
      expect(mirrored).toEqual([
        [
          { role: "user", content: "x".repeat(10) },
          { role: "assistant", content: "y".repeat(10) },
        ],
      ]);
      expect(history.getCapturable()).toEqual(history.getMessages());
    });

    it("a compression over the resumed part alone mirrors nothing", async () => {
      const mirrored: Message[][] = [];
      const history = createSessionHistory(fakeSummarizer(), (batch) => mirrored.push(batch), undefined, resumed);
      await history.addUserMessage("z".repeat(MAX_HISTORY_CHARS));
      expect(mirrored).toEqual([]);
      expect(history.getMessages()).toEqual([
        { role: "assistant", content: "Earlier conversation summary: a summary" },
        { role: "user", content: "z".repeat(MAX_HISTORY_CHARS) },
      ]);
      expect(history.getCapturable()).toEqual(history.getMessages());
    });

    it("without resumed, getCapturable is getMessages", async () => {
      const history = createSessionHistory(fakeSummarizer(), undefined, "primer");
      await history.addUserMessage("hi");
      expect(history.getCapturable()).toEqual(history.getMessages());
    });
  });
});
