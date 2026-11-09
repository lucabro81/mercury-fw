import { describe, it, expect } from "bun:test";
import { createPresentTool } from "./present-tool.ts";
import { createDisplayStore } from "./display-store.ts";

describe("createPresentTool", () => {
  it("surfaces a valid ref so it is shown at finalize", async () => {
    const store = createDisplayStore({ refFn: () => "d1" });
    store.stash("terminal", "MER-1\nhttps://x");
    const { present } = createPresentTool({ sessionKey: "terminal", store });

    const result = await present.execute({ ref: "d1" }, {} as never);
    expect(result).toEqual({ ok: true });
    expect(store.takeSurfaced("terminal")).toEqual(["MER-1\nhttps://x"]);
  });

  it("returns a self-correctable error for an unknown ref, without surfacing anything", async () => {
    const store = createDisplayStore({ refFn: () => "d1" });
    store.stash("terminal", "MER-1\nhttps://x");
    const { present } = createPresentTool({ sessionKey: "terminal", store });

    const result = (await present.execute({ ref: "d999" }, {} as never)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(store.takeSurfaced("terminal")).toEqual([]);
  });

  it("scopes surfacing to its own session: can't present another session's ref", async () => {
    const store = createDisplayStore({ refFn: () => "d1" });
    store.stash("spaces/X:users/42", "MER-1\nhttps://x");
    const { present } = createPresentTool({ sessionKey: "terminal", store });

    const result = (await present.execute({ ref: "d1" }, {} as never)) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(store.takeSurfaced("spaces/X:users/42")).toEqual([]);
  });
});

// #230: a list shown in an earlier turn can be shown again by its ref, named
// at the end of the prompt.
describe("createPresentTool description", () => {
  it("says a ref from the lists already shown can be shown again", () => {
    const { present } = createPresentTool({ sessionKey: "s", store: createDisplayStore() });
    expect(present.description).toContain('or one listed under "Lists already shown" to show it again');
  });
});

// #376: a result the instance shows always says `shown: true`; the model must
// neither present it again nor retype what the person already sees.
describe("createPresentTool description: shown results", () => {
  it("says a result marked shown is already shown, not to present or repeat", () => {
    const { present } = createPresentTool({ sessionKey: "s", store: createDisplayStore() });
    expect(present.description).toContain(
      "A result with `shown: true` is already shown to the user: don't call present for it and don't repeat its content, write only what goes around it.",
    );
  });
});
