/**
 * Regression tests for #68: an unreachable Qdrant at startup made the setup's
 * awaits reject `composeMercury` and crash the process. The setup runs in the
 * background and retries until the store answers.
 */
import { describe, it, expect } from "bun:test";
import { setUpWhenReachable } from "./when-reachable.ts";

describe("setUpWhenReachable", () => {
  it("runs the setup once and logs nothing when Qdrant answers at once", async () => {
    let calls = 0;
    const logs: string[] = [];
    const { done } = setUpWhenReachable(async () => void calls++, { log: (m) => logs.push(m), retryMs: 1 });

    await done;

    expect(calls).toBe(1);
    expect(logs).toEqual([]);
  });

  it("doesn't throw when Qdrant is down, retries, and says when memory is back", async () => {
    let calls = 0;
    const logs: string[] = [];
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 4) throw new Error("ConnectionRefused");
      },
      { log: (m) => logs.push(m), retryMs: 1 },
    );

    await done;

    expect(calls).toBe(4);
    // One line when it goes missing, one when it's back: not one per retry.
    expect(logs).toEqual([
      "conversation store unreachable, nothing is archived or reopened until it answers (retrying every 0.001s): Error: ConnectionRefused",
      "conversation store reachable, ready",
    ]);
  });

  it("logs Qdrant going missing once, however many retries fail", async () => {
    let calls = 0;
    const logs: string[] = [];
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 20) throw new Error("down");
      },
      { log: (m) => logs.push(m), retryMs: 1 },
    );

    await done;

    expect(calls).toBe(20);
    expect(logs.filter((m) => m.startsWith("conversation store unreachable"))).toHaveLength(1);
    expect(logs).toHaveLength(2);
  });

  it("stops retrying after the first success", async () => {
    let calls = 0;
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 2) throw new Error("down");
      },
      { log: () => {}, retryMs: 1 },
    );

    await done;
    await Bun.sleep(20);

    expect(calls).toBe(2);
  });
});

// #23: the memory store going missing and coming back reach the traces.
describe("setUpWhenReachable: memory store events", () => {
  it("emits an error when Qdrant goes missing and a recovery when it's back, once each", async () => {
    const events: Array<Record<string, unknown>> = [];
    let calls = 0;
    const { done } = setUpWhenReachable(
      async () => {
        calls++;
        if (calls < 3) throw new Error("ConnectionRefused");
      },
      { log: () => {}, retryMs: 1, emit: (e) => void events.push(e) },
    );
    await done;
    expect(events).toEqual([
      { kind: "system.error", area: "memory-store", args: { error: "Error: ConnectionRefused" } },
      { kind: "system.recovered", area: "memory-store" },
    ]);
  });
});
