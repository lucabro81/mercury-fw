import { describe, expect, test } from "bun:test";
import { compressionEvent } from "./compression-events.ts";

describe("compressionEvent", () => {
  test("a compression a conversation reports is an event: how many messages it folded, the characters before and after, how long it took", () => {
    expect(compressionEvent({ messages: 2, charsBefore: 13, charsAfter: 8, durationMs: 1200, outcome: "done" })).toEqual({
      kind: "history.compressed",
      messages: 2,
      charsBefore: 13,
      charsAfter: 8,
      durationMs: 1200,
      outcome: "done",
    });
  });

  test("one that failed carries its error in args, as the event did when the core compressed", () => {
    expect(compressionEvent({ messages: 2, charsBefore: 13, durationMs: 0, outcome: "failed", error: "model down" })).toEqual({
      kind: "history.compressed",
      messages: 2,
      charsBefore: 13,
      durationMs: 0,
      outcome: "failed",
      args: { error: "model down" },
    });
  });
});
