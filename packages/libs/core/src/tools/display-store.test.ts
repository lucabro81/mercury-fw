import { describe, it, expect } from "bun:test";
import { createDisplayStore } from "./display-store.ts";

describe("createDisplayStore", () => {
  it("stashes an artifact under a fresh ref and surfaces it back on takeSurfaced", () => {
    let n = 0;
    const store = createDisplayStore({ refFn: () => `d${++n}` });
    const ref = store.stash("terminal", "MER-1\nhttps://x");
    expect(ref).toBe("d1");

    // stashed but not yet surfaced: nothing to render
    expect(store.takeSurfaced("terminal")).toEqual([]);

    expect(store.surface("terminal", "d1")).toBe(true);
    expect(store.takeSurfaced("terminal")).toEqual(["MER-1\nhttps://x"]);
  });

  it("returns surfaced artifacts in stash order, only the ones actually surfaced", () => {
    let n = 0;
    const store = createDisplayStore({ refFn: () => `d${++n}` });
    const a = store.stash("terminal", "list-a");
    store.stash("terminal", "list-b"); // stashed, never surfaced
    const c = store.stash("terminal", "list-c");

    expect(store.surface("terminal", c)).toBe(true);
    expect(store.surface("terminal", a)).toBe(true);

    // stash order (a before c), not surface order (c before a)
    expect(store.takeSurfaced("terminal")).toEqual(["list-a", "list-c"]);
  });

  it("takeSurfaced consumes the surfaced flag so the same turn's artifact isn't re-appended next turn", () => {
    const store = createDisplayStore({ refFn: () => "d1" });
    store.stash("terminal", "list-a");
    store.surface("terminal", "d1");

    expect(store.takeSurfaced("terminal")).toEqual(["list-a"]);
    // second finalize in a later turn, present not called again: nothing
    expect(store.takeSurfaced("terminal")).toEqual([]);
  });

  it("lets a still-valid ref be surfaced again across turns (session-scoped, not turn-scoped)", () => {
    const store = createDisplayStore({ refFn: () => "d1" });
    store.stash("terminal", "list-a");

    store.surface("terminal", "d1");
    expect(store.takeSurfaced("terminal")).toEqual(["list-a"]);

    // a follow-up turn: "show me that list again" → present(d1) still works
    expect(store.surface("terminal", "d1")).toBe(true);
    expect(store.takeSurfaced("terminal")).toEqual(["list-a"]);
  });

  it("does not surface a ref for the wrong session, and doesn't leak it there", () => {
    const store = createDisplayStore({ refFn: () => "d1" });
    store.stash("terminal", "list-a");

    expect(store.surface("spaces/X:users/42", "d1")).toBe(false);
    expect(store.takeSurfaced("spaces/X:users/42")).toEqual([]);
    // the wrong-session attempt didn't mark it: the owner can still surface it
    expect(store.surface("terminal", "d1")).toBe(true);
    expect(store.takeSurfaced("terminal")).toEqual(["list-a"]);
  });

  it("returns false when surfacing an unknown ref", () => {
    const store = createDisplayStore();
    expect(store.surface("terminal", "nope")).toBe(false);
  });

  it("returns false when surfacing a ref past its expiry, and cleans it up", () => {
    let now = 0;
    const store = createDisplayStore({ now: () => now, ttlMs: 1000, refFn: () => "d1" });
    store.stash("terminal", "list-a");

    now = 1001;
    expect(store.surface("terminal", "d1")).toBe(false);

    // actually deleted, not just failing the expiry check: moving time back
    // doesn't resurrect it
    now = 0;
    expect(store.surface("terminal", "d1")).toBe(false);
  });

  it("scopes takeSurfaced by session: one session's surfaced artifacts don't reach another", () => {
    let n = 0;
    const store = createDisplayStore({ refFn: () => `d${++n}` });
    const a = store.stash("terminal", "list-a");
    const b = store.stash("spaces/X:users/42", "list-b");

    store.surface("terminal", a);
    store.surface("spaces/X:users/42", b);

    expect(store.takeSurfaced("terminal")).toEqual(["list-a"]);
    expect(store.takeSurfaced("spaces/X:users/42")).toEqual(["list-b"]);
  });

  it("reclaims expired entries during a takeSurfaced sweep, not just on a surface attempt", () => {
    // Regression: takeSurfaced skipped expired entries but never deleted them,
    // so in the process-lifetime shared store every un-surfaced (or never
    // re-surfaced) stash leaked forever. The finalize-time sweep must reclaim
    // them.
    let now = 0;
    const store = createDisplayStore({ now: () => now, ttlMs: 1000, refFn: () => "d1" });
    store.stash("terminal", "list-a"); // stashed, never surfaced

    now = 1001; // past its TTL
    expect(store.takeSurfaced("terminal")).toEqual([]); // the sweep runs here

    // proof it was actually deleted, not merely failing the expiry check:
    // moving time back doesn't resurrect it as surfaceable
    now = 0;
    expect(store.surface("terminal", "d1")).toBe(false);
  });

  it("mints distinct default refs when refFn isn't injected", () => {
    const store = createDisplayStore();
    const a = store.stash("terminal", "list-a");
    const b = store.stash("terminal", "list-b");
    expect(a).not.toBe(b);
    expect(store.surface("terminal", a)).toBe(true);
    expect(store.takeSurfaced("terminal")).toEqual(["list-a"]);
  });
});

// #230: a turn after a list was shown, the model no longer knew which list it
// was and retyped it with made-up keys. The store keeps what each shown list
// is for the whole conversation, so the prompt can say so.
describe("createDisplayStore: lists shown in a conversation", () => {
  const HOUR = 60 * 60_000;

  it("keeps a ref for a day by default, not minutes", () => {
    let now = 0;
    const store = createDisplayStore({ now: () => now, refFn: () => "d1" });
    store.stash("s", "list-a");
    now = 24 * HOUR - 1;
    expect(store.surface("s", "d1")).toBe(true);
    now = 24 * HOUR + 1;
    expect(store.surface("s", "d1")).toBe(false);
  });

  it("lists what was shown, with its label, most recently shown last, after the turn that showed it too", () => {
    let n = 0;
    let now = 0;
    const store = createDisplayStore({ now: () => now, refFn: () => `d${++n}` });
    store.stash("s", "list-a", "jira issue search A (2 items)");
    store.stash("s", "list-b", "jira issue search B (3 items)"); // never shown
    store.stash("s", "list-c");
    now = 1;
    store.surface("s", "d1");
    now = 2;
    store.surface("s", "d3");
    store.takeSurfaced("s");
    expect(store.shown("s")).toEqual([
      { ref: "d1", label: "jira issue search A (2 items)" },
      { ref: "d3", label: "" },
    ]);
    // shown again later: it moves to the end
    now = 3;
    store.surface("s", "d1");
    expect(store.shown("s").map((s) => s.ref)).toEqual(["d3", "d1"]);
  });

  it("lists nothing for another session, nor an expired list", () => {
    let now = 0;
    const store = createDisplayStore({ now: () => now, ttlMs: 1000, refFn: () => "d1" });
    store.stash("s", "list-a", "A");
    store.surface("s", "d1");
    expect(store.shown("other")).toEqual([]);
    now = 1001;
    expect(store.shown("s")).toEqual([]);
  });

  it("forgets a closed conversation's lists, and only those", () => {
    let n = 0;
    const store = createDisplayStore({ refFn: () => `d${++n}` });
    store.stash("s", "list-a", "A");
    store.stash("t", "list-b", "B");
    store.surface("s", "d1");
    store.surface("t", "d2");
    store.forget("s");
    expect(store.shown("s")).toEqual([]);
    expect(store.surface("s", "d1")).toBe(false);
    expect(store.shown("t")).toEqual([{ ref: "d2", label: "B" }]);
  });

  it("keeps at most the 10 most recent lists of a conversation", () => {
    let n = 0;
    const store = createDisplayStore({ refFn: () => `d${++n}` });
    store.stash("t", "other", "T");
    for (let i = 1; i <= 11; i++) store.stash("s", `list-${i}`, `L${i}`);
    expect(store.surface("s", "d2")).toBe(false); // the oldest of "s", evicted
    expect(store.surface("s", "d3")).toBe(true);
    expect(store.surface("s", "d12")).toBe(true);
    expect(store.surface("t", "d1")).toBe(true); // another conversation is untouched
  });
});
