import { describe, expect, test } from "bun:test";
import type { Message } from "./history.ts";
import { createSessionCapture } from "./session-capture.ts";
import type { Texts } from "../i18n/i18n.ts";

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
  // #383: the threshold capture is background work queued for the model;
  // awaited by the turn, it would hold the session's next turn behind it.
  test("maybeCapture returns before its capture is done", async () => {
    const hold = gate();
    const r = recorder({ hold: hold.promise });
    const c = createSessionCapture({ capture: r.capture, threshold: 2 });
    c.track("s", "u1");
    await c.maybeCapture("s", msgs(0, 2));
    expect(r.captured).toEqual([]);
    hold.open();
    await c.settled();
    expect(r.captured).toEqual([["m0", "m1"]]);
  });

  test("a trigger while a capture runs captures only what came after it", async () => {
    const hold = gate();
    const r = recorder({ hold: hold.promise });
    const c = createSessionCapture({ capture: r.capture, threshold: 2 });
    c.track("s", "u1");
    await c.maybeCapture("s", msgs(0, 2));
    await c.maybeCapture("s", msgs(0, 3));
    await c.maybeCapture("s", msgs(0, 4));
    hold.open();
    await c.settled();
    expect(r.captured).toEqual([
      ["m0", "m1"],
      ["m2", "m3"],
    ]);
  });

  test("a capture that fails puts the marker back: the next trigger captures its messages again", async () => {
    let failing = true;
    const r = recorder({ fail: () => failing });
    const c = createSessionCapture({ capture: r.capture, threshold: 2, log: () => {} });
    c.track("s", "u1");
    await c.maybeCapture("s", msgs(0, 2));
    await c.settled();
    failing = false;
    await c.maybeCapture("s", msgs(0, 2));
    await c.settled();
    expect(r.captured).toEqual([["m0", "m1"]]);
  });

  // #383: a capture can run long after its turn, when the channel that asked is gone: its status failing never loses the capture.
  test("a status callback that throws doesn't stop the capture", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 1, log: () => {} });
    c.track("s", "u1");
    c.registerCallbacks("s", {
      onToolStart: () => {
        throw new Error("sink disposed");
      },
      onToolFinish: () => {
        throw new Error("sink disposed");
      },
    });
    await c.maybeCapture("s", msgs(0, 1));
    await c.settled();
    expect(r.captured).toEqual([["m0"]]);
    await c.maybeCapture("s", msgs(0, 2));
    await c.settled();
    expect(r.captured).toEqual([["m0"], ["m1"]]);
  });

  test("each capture runs as a job, its status pinged from inside it", async () => {
    const order: string[] = [];
    const c = createSessionCapture({
      capture: async () => void order.push("capture"),
      threshold: 1,
      job: async (fn) => {
        order.push("job start");
        const result = await fn();
        order.push("job end");
        return result;
      },
    });
    c.track("s", "u1");
    c.registerCallbacks("s", { onToolStart: () => order.push("status start"), onToolFinish: () => order.push("status end") });
    await c.maybeCapture("s", msgs(0, 1));
    await c.settled();
    await c.maybeCapture("s", msgs(0, 2));
    await c.settled();
    expect(order).toEqual([
      "job start", "status start", "capture", "status end", "job end",
      "job start", "status start", "capture", "status end", "job end",
    ]);
  });

  test("maybeCapture captures what's new once the threshold is reached, then only what came after", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 4 });
    c.track("s", "u1");

    await c.maybeCapture("s", msgs(0, 3));

    await c.settled();
    expect(r.captured).toEqual([]);
    await c.maybeCapture("s", msgs(0, 4));
    await c.settled();
    await c.maybeCapture("s", msgs(0, 8));
    await c.settled();
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

    await c.settled();
    failing = false;
    await c.maybeCapture("s", msgs(0, 3));
    await c.settled();
    expect(r.captured).toEqual([["m0", "m1", "m2"]]);
  });

  test("an untracked session is never captured", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 1 });
    await c.maybeCapture("s", msgs(0, 3));
    await c.settled();
    expect(r.captured).toEqual([]);
  });

  // With the window in a plugin (#393) nothing tells the capture a compression
  // happened: it sees the view shorter than what it already mirrored. Measuring
  // the new view against the old marker skipped everything until the view grew
  // past it again; now a shorter view restarts the count.
  test("a view shorter than what was captured (the conversation compressed) restarts the count from it", async () => {
    const r = recorder();
    const c = createSessionCapture({ capture: r.capture, threshold: 3 });
    c.track("s", "u1");
    await c.maybeCapture("s", msgs(0, 4));
    await c.settled();

    await c.maybeCapture("s", [msg(100), msg(101)]);
    await c.settled();
    expect(r.captured).toEqual([["m0", "m1", "m2", "m3"]]);
    const afterCompression = [msg(100), msg(101), msg(102)];
    await c.maybeCapture("s", afterCompression);
    await c.settled();
    expect(r.captured).toEqual([
      ["m0", "m1", "m2", "m3"],
      ["m100", "m101", "m102"],
    ]);
    // Nothing is captured twice afterwards.
    await c.maybeCapture("s", afterCompression);
    await c.settled();
    expect(r.captured).toHaveLength(2);
  });

});

// #23: the traces say which trigger started each capture.
describe("createSessionCapture: the trigger", () => {
  test("the threshold tells the capture it was the threshold", async () => {
    const triggers: string[] = [];
    const c = createSessionCapture({
      capture: async (_u, _k, _m, trigger) => void triggers.push(trigger),
      threshold: 2,
    });
    c.track("s", "u1");
    await c.maybeCapture("s", msgs(0, 2));
    await c.settled();
    expect(triggers).toEqual(["threshold"]);
  });
});
