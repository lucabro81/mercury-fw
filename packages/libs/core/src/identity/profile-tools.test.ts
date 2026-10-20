import { describe, expect, test } from "bun:test";
import { createProfileTools } from "./profile-tools.ts";
import type { ProfileStore } from "./profiles.ts";

/** A store in memory, refusing what the real one refuses. */
function memoryStore(): ProfileStore & { names: Map<string, string>; languages: Map<string, string> } {
  const names = new Map<string, string>();
  const languages = new Map<string, string>();
  return {
    names,
    languages,
    languageOf: (key) => languages.get(key),
    setLanguage: (key, language) => {
      languages.set(key, language);
      return language;
    },
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

const setLanguage = (tools: ReturnType<typeof createProfileTools>, language: string) =>
  tools.set_preferred_language!.execute!({ language }, {} as never);

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

describe("set_preferred_language", () => {
  const languages = ["en", "it"];

  test("isn't offered when the instance speaks English only: nothing to choose", () => {
    expect(createProfileTools({ store: memoryStore(), key: "k" }).set_preferred_language).toBeUndefined();
    expect(createProfileTools({ store: memoryStore(), key: "k", languages: ["en"] }).set_preferred_language).toBeUndefined();
  });

  test("saves a supported language for the person the turn is for, and nobody else", async () => {
    const store = memoryStore();
    expect(await setLanguage(createProfileTools({ store, key: "static:alice", languages }), "it")).toEqual({ ok: true, language: "it" });
    expect([...store.languages]).toEqual([["static:alice", "it"]]);
  });

  test("accepts only the languages the instance ships", () => {
    const { set_preferred_language } = createProfileTools({ store: memoryStore(), key: "k", languages });
    const schema = set_preferred_language!.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ language: "it" }).success).toBe(true);
    expect(schema.safeParse({ language: "fr" }).success).toBe(false);
  });

  test("names the languages the model can pick from", () => {
    const { description } = createProfileTools({ store: memoryStore(), key: "k", languages }).set_preferred_language!;
    expect(description).toContain("language the person you're talking to wants");
    expect(description).toContain("en, it");
  });
});
