import { describe, expect, test } from "bun:test";
import { createProfileTools } from "./profile-tools.ts";
import type { ProfileStore } from "./profiles.ts";

/** A store in memory, refusing what the real one refuses. */
function memoryStore(): ProfileStore & { names: Map<string, string> } {
  const names = new Map<string, string>();
  return {
    names,
    nameOf: (key) => names.get(key),
    setName: (key, name) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) throw new Error("the name is empty");
      names.set(key, trimmed);
      return trimmed;
    },
  };
}

const run = (tools: ReturnType<typeof createProfileTools>, name: string) =>
  tools.set_preferred_name.execute!({ name }, {} as never);

describe("set_preferred_name", () => {
  test("saves the name for the person the turn is for, and nobody else", async () => {
    const store = memoryStore();
    expect(await run(createProfileTools({ store, key: "static:alice" }), " Luca ")).toEqual({ ok: true, name: "Luca" });
    expect([...store.names]).toEqual([["static:alice", "Luca"]]);
  });

  test("a refused name is an error for the model, with the reason", async () => {
    const store = memoryStore();
    expect(await run(createProfileTools({ store, key: "static:alice" }), "  ")).toEqual({ ok: false, error: "the name is empty" });
    expect(store.names.size).toBe(0);
  });

  test("says when to use it", () => {
    const { description } = createProfileTools({ store: memoryStore(), key: "k" }).set_preferred_name;
    expect(description).toContain("how the person you're talking to wants to be called");
  });
});
