import { describe, expect, test } from "bun:test";
import type { Message } from "../session/history.ts";
import { withCompressionEvents } from "./compression-events.ts";
import type { TraceInput } from "./tracer.ts";

const messages: Message[] = [
  { role: "user", content: "hello there" },
  { role: "assistant", content: "hi" },
];

describe("withCompressionEvents", () => {
  test("a compression is an event: how many messages it folded, the characters before and after, how long it took", async () => {
    const events: TraceInput[] = [];
    let clock = 0;
    const summarize = withCompressionEvents(
      async () => {
        clock += 1_200;
        return "greeting";
      },
      { emit: (e) => events.push(e), now: () => clock },
    );
    expect(await summarize(messages)).toBe("greeting");
    expect(events).toEqual([
      { kind: "history.compressed", messages: 2, charsBefore: 13, charsAfter: 8, durationMs: 1200, outcome: "done" },
    ]);
  });

  test("a summarizer that fails still leaves its event, and the failure reaches the history as before", async () => {
    const events: TraceInput[] = [];
    const summarize = withCompressionEvents(
      async () => {
        throw new Error("model down");
      },
      { emit: (e) => events.push(e), now: () => 0 },
    );
    await expect(summarize(messages)).rejects.toThrow("model down");
    expect(events).toEqual([
      { kind: "history.compressed", messages: 2, charsBefore: 13, durationMs: 0, outcome: "failed", args: { error: "model down" } },
    ]);
  });
});
