import { describe, expect, test } from "bun:test";
import type { Profiles } from "@mercury-fw/plugin-types";
import { createProfileTools } from "./profile-tools.ts";

/** The core's profiles in memory, shipping `shipped`, refusing what the real ones refuse. */
function memoryStore(
  shipped: string[] = ["en"],
): Profiles & { names: Map<string, string>; savedLanguages: Map<string, string>; timeZones: Map<string, string> } {
  const names = new Map<string, string>();
  const languages = new Map<string, string>();
  const timeZones = new Map<string, string>();
  return {
    names,
    savedLanguages: languages,
    languages: shipped,
    timeZones,
    timeZoneOf: (key) => timeZones.get(key),
    setTimeZone: (key, timeZone) => {
      if (timeZone !== "Europe/Rome" && timeZone !== "Asia/Tokyo") throw new Error(`"${timeZone}" isn't a time zone`);
      timeZones.set(key, timeZone);
      return timeZone;
    },
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

const setTimeZone = (tools: ReturnType<typeof createProfileTools>, timeZone: string) =>
  tools.set_time_zone.execute!({ timeZone }, {} as never);

describe("set_preferred_name", () => {
  test("saves the name for the person the turn is for, and nobody else", async () => {
    const store = memoryStore();
    expect(await run(createProfileTools({ profiles: store, key: "static:alice" }), " Luca ")).toEqual({ ok: true, name: "Luca" });
    expect([...store.names]).toEqual([["static:alice", "Luca"]]);
  });

  test("a refused name is an error for the model, with the reason", async () => {
    const store = memoryStore();
    expect(await run(createProfileTools({ profiles: store, key: "static:alice" }), "  ")).toEqual({ ok: false, error: "the name is empty" });
    expect(store.names.size).toBe(0);
  });

  test("says when to use it", () => {
    const { description } = createProfileTools({ profiles: memoryStore(), key: "k" }).set_preferred_name;
    expect(description).toContain("how the person you're talking to wants to be called");
  });
});

describe("set_preferred_language", () => {
  const languages = ["en", "it"];

  test("isn't offered when the instance speaks English only: nothing to choose", () => {
    expect(createProfileTools({ profiles: memoryStore(), key: "k" }).set_preferred_language).toBeUndefined();
    expect(createProfileTools({ profiles: memoryStore(["en"]), key: "k" }).set_preferred_language).toBeUndefined();
  });

  test("saves a supported language for the person the turn is for, and nobody else", async () => {
    const store = memoryStore(languages);
    expect(await setLanguage(createProfileTools({ profiles: store, key: "static:alice" }), "it")).toEqual({ ok: true, language: "it" });
    expect([...store.savedLanguages]).toEqual([["static:alice", "it"]]);
  });

  test("accepts only the languages the instance ships", () => {
    const { set_preferred_language } = createProfileTools({ profiles: memoryStore(languages), key: "k" });
    const schema = set_preferred_language!.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ language: "it" }).success).toBe(true);
    expect(schema.safeParse({ language: "fr" }).success).toBe(false);
  });

  test("names the languages the model can pick from", () => {
    const { description } = createProfileTools({ profiles: memoryStore(languages), key: "k" }).set_preferred_language!;
    expect(description).toContain("language the person you're talking to wants");
    expect(description).toContain("en, it");
  });
});

describe("set_time_zone", () => {
  test("is there whatever languages the instance ships", () => {
    expect(createProfileTools({ profiles: memoryStore(), key: "k" }).set_time_zone).toBeDefined();
  });

  test("saves the zone for the person the turn is for, and nobody else", async () => {
    const store = memoryStore();
    expect(await setTimeZone(createProfileTools({ profiles: store, key: "static:alice" }), "Asia/Tokyo")).toEqual({ ok: true, timeZone: "Asia/Tokyo" });
    expect([...store.timeZones]).toEqual([["static:alice", "Asia/Tokyo"]]);
  });

  test("a refused zone is an error for the model, with the reason", async () => {
    const store = memoryStore();
    expect(await setTimeZone(createProfileTools({ profiles: store, key: "static:alice" }), "Rome")).toEqual({ ok: false, error: '"Rome" isn\'t a time zone' });
    expect(store.timeZones.size).toBe(0);
  });

  test("says when to use it and what a zone looks like", () => {
    const { description } = createProfileTools({ profiles: memoryStore(), key: "k" }).set_time_zone;
    expect(description).toContain("time zone the person you're talking to is in");
    expect(description).toContain("Europe/Rome");
  });
});
