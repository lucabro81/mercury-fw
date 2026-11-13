import { describe, it, expect } from "bun:test";
import { normalizeIndexKey, upsertIndexEntry, removeIndexEntry } from "./index-entry.ts";

describe("normalizeIndexKey", () => {
  it("strips a leading curated/ prefix", () => {
    expect(normalizeIndexKey("curated/projects/project-codes.md")).toBe("projects/project-codes");
  });

  it("strips a trailing .md suffix even without a curated/ prefix", () => {
    expect(normalizeIndexKey("projects/project-codes.md")).toBe("projects/project-codes");
  });

  it("leaves an already-normalized key untouched", () => {
    expect(normalizeIndexKey("projects/project-codes")).toBe("projects/project-codes");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIndexKey("  projects/project-codes.md  ")).toBe("projects/project-codes");
  });
});

describe("upsertIndexEntry", () => {
  it("appends a new entry to empty content", () => {
    const result = upsertIndexEntry("", "projects/project-codes", "Project name to code mapping");
    expect(result).toBe("- [[projects/project-codes]] — Project name to code mapping\n");
  });

  it("appends a new entry after existing ones, without touching them", () => {
    const existing = "- [[standards/jira-fields]] — custom field conventions\n";
    const result = upsertIndexEntry(existing, "projects/project-codes", "Project name to code mapping");
    expect(result).toBe(
      "- [[standards/jira-fields]] — custom field conventions\n" +
        "- [[projects/project-codes]] — Project name to code mapping\n",
    );
  });

  it("replaces an existing entry for the same key in place, instead of duplicating it", () => {
    const existing =
      "- [[standards/jira-fields]] — custom field conventions\n" +
      "- [[projects/project-codes]] — old description\n" +
      "- [[glossary]] — team glossary\n";
    const result = upsertIndexEntry(existing, "projects/project-codes", "new description");
    expect(result).toBe(
      "- [[standards/jira-fields]] — custom field conventions\n" +
        "- [[projects/project-codes]] — new description\n" +
        "- [[glossary]] — team glossary\n",
    );
  });

  it("produces a line the orphan-detector's wikilink check recognizes", () => {
    const result = upsertIndexEntry("", "projects/project-codes", "Project name to code mapping");
    expect(result).toMatch(/\[\[projects\/project-codes\]\]/);
  });
});

describe("removeIndexEntry", () => {
  it("removes an existing entry's line", () => {
    const existing =
      "- [[standards/jira-fields]] — custom field conventions\n" + "- [[glossary]] — team glossary\n";
    const result = removeIndexEntry(existing, "standards/jira-fields");
    expect(result).toBe("- [[glossary]] — team glossary\n");
  });

  it("is a no-op when the key has no entry", () => {
    const existing = "- [[glossary]] — team glossary\n";
    const result = removeIndexEntry(existing, "standards/jira-fields");
    expect(result).toBe(existing);
  });

  it("returns an empty string when removing the only entry", () => {
    const existing = "- [[glossary]] — team glossary\n";
    const result = removeIndexEntry(existing, "glossary");
    expect(result).toBe("");
  });
});
