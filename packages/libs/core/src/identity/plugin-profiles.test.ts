import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "./profiles.ts";
import { pluginProfiles } from "./plugin-profiles.ts";

/** A profile store on a fresh file, and the plugins' view of it over `languages`. */
function setup(languages: string[]) {
  const store = createProfileStore({ path: join(mkdtempSync(join(tmpdir(), "profiles-")), "profiles.json") });
  return { store, profiles: pluginProfiles(store, () => languages) };
}

describe("pluginProfiles", () => {
  it("reads and writes the same profiles the core keeps", () => {
    const { store, profiles } = setup(["en", "it"]);
    expect(profiles.setName("static:alice", "  Ali ")).toBe("Ali");
    expect(profiles.setTimeZone("static:alice", "europe/rome")).toBe("Europe/Rome");
    expect(profiles.setLanguage("static:alice", "IT")).toBe("it");
    expect([store.nameOf("static:alice"), store.timeZoneOf("static:alice"), store.languageOf("static:alice")]).toEqual(["Ali", "Europe/Rome", "it"]);
    expect([profiles.nameOf("static:alice"), profiles.timeZoneOf("static:alice"), profiles.languageOf("static:alice")]).toEqual(["Ali", "Europe/Rome", "it"]);
    expect(profiles.nameOf("static:bob")).toBeUndefined();
  });

  it("refuses a language the instance doesn't ship, saving nothing", () => {
    const { store, profiles } = setup(["en", "it"]);
    expect(() => profiles.setLanguage("static:alice", "fr")).toThrow('"fr" isn\'t a language this instance ships: en, it');
    expect(store.languageOf("static:alice")).toBeUndefined();
  });

  it("refuses what the store refuses: a time zone that doesn't exist", () => {
    const { profiles } = setup(["en"]);
    expect(() => profiles.setTimeZone("static:alice", "Mars/Olympus")).toThrow();
  });

  it("lists the languages the instance ships, as they are when asked", () => {
    let languages = ["en"];
    const store = createProfileStore({ path: join(mkdtempSync(join(tmpdir(), "profiles-")), "profiles.json") });
    const profiles = pluginProfiles(store, () => languages);
    languages = ["en", "it"];
    expect(profiles.languages).toEqual(["en", "it"]);
  });
});
