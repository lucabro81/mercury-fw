import { describe, expect, test } from "bun:test";
import type { Message } from "./history.ts";
import { createSessionCapture } from "./session-capture.ts";

const msg = (n: number): Message => ({ role: n % 2 === 0 ? "user" : "assistant", content: `m${n}` });
const msgs = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => msg(from + i));

/** A promise plus the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A capture that records what it was given, and fails when `fail` says so. */
function recorder(opts: { fail?: () => boolean; hold?: Promise<void> } = {}) {
  const captured: string[][] = [];
  const capture = async (_userId: string, _key: string, messages: Message[]) => {
    await opts.hold;
    if (opts.fail?.()) throw new Error("qdrant down");
    captured.push(messages.map((m) => m.content));
  };
  return { captured, capture };
}

describe("createSessionCapture", () => {
  test("maybeCapture captures what's new once the threshold is reached, then only what came after", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 4 });
    c.track("s", "u1");

    await c.maybeCapture("s", msgs(0, 3));
    expect(r.captured).toEqual([]);
    await c.maybeCapture("s", msgs(0, 4));
    await c.maybeCapture("s", msgs(0, 8));
    expect(r.captured).toEqual([
      ["m0", "m1", "m2", "m3"],
      ["m4", "m5", "m6", "m7"],
    ]);
  });

  test("a failed capture is retried with the same messages next time", async () => {
    let failing = true;
    const r = recorder({ fail: () => failing });
    const c = createSessionCapture({ capture: r.capture, threshold: 2, log: () => {} });
    c.track("s", "u1");

    await c.maybeCapture("s", msgs(0, 2));
    failing = false;
    await c.maybeCapture("s", msgs(0, 3));
    expect(r.captured).toEqual([["m0", "m1", "m2"]]);
  });

  test("an untracked session is never captured", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 1 });
    await c.maybeCapture("s", msgs(0, 3));
    c.onCompress("s", msgs(0, 3));
    expect(r.captured).toEqual([]);
  });

  test("onCompress captures what wasn't captured yet of the compressed messages", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 2 });
    c.track("s", "u1");
    await c.maybeCapture("s", msgs(0, 2));

    c.onCompress("s", msgs(0, 5));
    await c.settled();
    expect(r.captured).toEqual([
      ["m0", "m1"],
      ["m2", "m3", "m4"],
    ]);
  });

  // Regression for #154: the capture a compression triggered ran on its own
  // and only reset the marker when it finished, so a capture in between still
  // measured the compressed history's new view against the old marker (here
  // 4 against a view of 3 messages) and skipped what was new; and a
  // successful compression capture first set the marker to the old view's
  // length. Now the slice is fixed and the marker reset when the compression
  // happens.
  test("a capture after a compression counts from the new view while the compression's own capture is still running", async () => {
    const hold = gate();
    const r = recorder({ hold: hold.promise });
    const c = createSessionCapture({ capture: r.capture, threshold: 3 });
    c.track("s", "u1");

    c.onCompress("s", msgs(0, 4));
    const afterCompression = [msg(100), msg(101), msg(102)];
    const next = c.maybeCapture("s", afterCompression);
    hold.open();
    await next;
    await c.settled();

    expect(r.captured).toEqual([
      ["m0", "m1", "m2", "m3"],
      ["m100", "m101", "m102"],
    ]);
    // Nothing is captured twice afterwards.
    await c.maybeCapture("s", afterCompression);
    expect(r.captured).toHaveLength(2);
  });

  test("a capture pings the callbacks registered when it started, with the turn's status", async () => {
    const events: string[] = [];
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 1, describe: (pending) => `${pending.length} messages` });
    c.track("s", "u1");
    c.registerCallbacks("s", {
      onToolStart: (label, detail) => events.push(`start:${detail}`),
      onToolFinish: (_id, outcome) => events.push(`finish:${outcome}`),
    });

    await c.maybeCapture("s", msgs(0, 2));
    expect(events).toEqual(["start:2 messages", "finish:success"]);
  });

  test("close forgets the session", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 1 });
    c.track("s", "u1");
    expect(c.userOf("s")).toBe("u1");
    c.close("s");
    expect(c.userOf("s")).toBeUndefined();
    await c.maybeCapture("s", msgs(0, 2));
    expect(r.captured).toEqual([]);
  });
});
