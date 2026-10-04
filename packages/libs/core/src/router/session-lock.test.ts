import { describe, expect, test } from "bun:test";
import { createSessionLock } from "./session-lock.ts";

/** A promise plus the function that resolves it, to hold a run open until the test lets it go. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets every already-queued microtask and timer settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSessionLock", () => {
  test("runs work on the same key one at a time, in arrival order", async () => {
    const lock = createSessionLock();
    const events: string[] = [];
    const first = gate();

    const a = lock.run("s1", async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
      return "a";
    });
    const b = lock.run("s1", async () => {
      events.push("b:start");
      return "b";
    });

    await settle();
    expect(events).toEqual(["a:start"]);

    first.open();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  test("runs work on different keys in parallel", async () => {
    const lock = createSessionLock();
    const events: string[] = [];
    const first = gate();

    const a = lock.run("s1", async () => {
      events.push("a:start");
      await first.promise;
    });
    const b = lock.run("s2", async () => {
      events.push("b:start");
    });

    await b;
    expect(events).toEqual(["a:start", "b:start"]);
    first.open();
    await a;
  });

  test("a failed run rejects its own caller and doesn't block the next one", async () => {
    const lock = createSessionLock();
    const a = lock.run("s1", async () => {
      throw new Error("boom");
    });
    const b = lock.run("s1", async () => "b");

    await expect(a).rejects.toThrow("boom");
    expect(await b).toBe("b");
  });

  test("work aborted while it waits never starts, and resolves undefined", async () => {
    const lock = createSessionLock();
    const first = gate();
    const controller = new AbortController();
    let started = false;

    const a = lock.run("s1", () => first.promise);
    const b = lock.run(
      "s1",
      async () => {
        started = true;
        return "b";
      },
      controller.signal,
    );

    controller.abort();
    first.open();
    await a;
    expect(await b).toBeUndefined();
    expect(started).toBe(false);
  });

  test("work whose signal is already aborted never starts", async () => {
    const lock = createSessionLock();
    const controller = new AbortController();
    controller.abort();
    let started = false;

    const result = await lock.run(
      "s1",
      async () => {
        started = true;
      },
      controller.signal,
    );

    expect(result).toBeUndefined();
    expect(started).toBe(false);
  });

  test("a key is forgotten once nothing runs or waits on it", async () => {
    const lock = createSessionLock();
    const first = gate();

    const a = lock.run("s1", () => first.promise);
    const b = lock.run("s1", async () => {});
    expect(lock.activeKeys()).toEqual(["s1"]);

    first.open();
    await Promise.all([a, b]);
    await settle();
    expect(lock.activeKeys()).toEqual([]);
  });

  test("a key is forgotten after a failed run too", async () => {
    const lock = createSessionLock();
    await lock
      .run("s1", async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    await settle();
    expect(lock.activeKeys()).toEqual([]);
  });
});
