import { describe, expect, it } from "bun:test";
import { createResumeSlots } from "./resume-slots.ts";

const action = (describe: string) => ({ describe, toolName: "web_fetch", input: {}, output: { text: describe } });

describe("createResumeSlots", () => {
  it("hands back what was kept for a session once, then nothing", () => {
    const slots = createResumeSlots({ now: () => 0 });
    slots.keep("s1", action("a"));

    expect(slots.take("s1")).toEqual(action("a"));
    expect(slots.take("s1")).toBeUndefined();
  });

  it("keeps sessions apart", () => {
    const slots = createResumeSlots({ now: () => 0 });
    slots.keep("s1", action("a"));

    expect(slots.take("s2")).toBeUndefined();
    expect(slots.take("s1")).toEqual(action("a"));
  });

  it("a later confirmation in the same session replaces the one not resumed yet", () => {
    const slots = createResumeSlots({ now: () => 0 });
    slots.keep("s1", action("a"));
    slots.keep("s1", action("b"));

    expect(slots.take("s1")).toEqual(action("b"));
  });

  // Cold review of #235: a result nobody resumed (a channel that never asked,
  // an HTTP client that never opened /turn) stayed forever and came back in a
  // resumed turn hours later.
  it("forgets what was kept once it's older than its ttl", () => {
    let now = 0;
    const slots = createResumeSlots({ now: () => now, ttlMs: 1000 });
    slots.keep("s1", action("a"));
    slots.keep("s2", action("b"));

    now = 1000;
    expect(slots.take("s1")).toEqual(action("a"));
    now = 1001;
    expect(slots.take("s2")).toBeUndefined();
  });

  it("drops expired results when something new is kept, so they don't pile up", () => {
    let now = 0;
    const slots = createResumeSlots({ now: () => now, ttlMs: 1000 });
    slots.keep("s1", action("a"));
    now = 2000;
    slots.keep("s2", action("b"));

    expect(slots.size()).toBe(1);
  });
});
