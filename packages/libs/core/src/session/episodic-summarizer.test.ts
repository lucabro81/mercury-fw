import { describe, expect, it } from "bun:test";
import { createEpisodicSummarizer, EPISODIC_SUMMARY_INSTRUCTIONS } from "./episodic-summarizer.ts";

describe("the episodic summarizer's instructions", () => {
  // #233: a summary kept "the 4 open tickets on SUP with their statuses", and a
  // new conversation listed them again, stale, unasked. Data a tool returned is
  // read again when needed; the summary keeps what was asked and decided.
  it("keeps what was asked and decided, never the data a tool returned", () => {
    expect(EPISODIC_SUMMARY_INSTRUCTIONS).toContain(
      "Record what was asked, discussed and decided, not the data a tool returned (lists, counts, statuses, values): it changes, and is read again when needed.",
    );
  });

  it("still describes only this session, with no inferred habits", () => {
    expect(EPISODIC_SUMMARY_INSTRUCTIONS).toContain("Describe only what occurred in this session.");
    expect(EPISODIC_SUMMARY_INSTRUCTIONS).toContain("Do not infer patterns, habits, or preferences about the user");
  });

  // #293: the model used to invent dates (the wrong year, "replace with the
  // current date"); every message now says when it was written, and a date
  // is copied from there or not written at all.
  it("dates something only as a message's stamp says, never guessing", () => {
    expect(EPISODIC_SUMMARY_INSTRUCTIONS).toContain(
      "Each message from the user starts with when it was written, in brackets: mention a date only as written there, and never guess one.",
    );
    expect(EPISODIC_SUMMARY_INSTRUCTIONS).not.toContain("Never mention or guess a date");
  });
});

describe("createEpisodicSummarizer", () => {
  it("hands the model these instructions and the conversation, and returns its text", async () => {
    const calls: Array<{ instructions?: unknown; prompt?: unknown }> = [];
    const summarize = createEpisodicSummarizer({} as never, async (params) => {
      calls.push({ instructions: params.instructions, prompt: params.prompt });
      return { text: "asked for SUP tickets" };
    });
    const text = await summarize([
      { role: "user", content: "i miei ticket" },
      { role: "assistant", content: "eccoli" },
    ]);
    expect(text).toBe("asked for SUP tickets");
    expect(calls).toEqual([{ instructions: EPISODIC_SUMMARY_INSTRUCTIONS, prompt: "user: i miei ticket\nassistant: eccoli" }]);
  });
});
