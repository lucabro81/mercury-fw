/**
 * Reading a note back and changing only its frontmatter (the dreaming pass's
 * statuses, a lock) or its body, in the vault's commit queue.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "./vault-init.ts";
import {
  parseNote,
  readNote,
  renderNote,
  rewriteNoteBody,
  updateNoteFrontmatter,
  writeCuratedNote,
  writePersonalNote,
  writeToolCorrectionNote,
} from "./wiki-note.ts";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-wiki-note-update-test-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function gitLog(vaultPath: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "log", "--format=%s"], { cwd: vaultPath, stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim().split("\n").filter(Boolean);
}

describe("parseNote and renderNote", () => {
  it("split a note into its frontmatter and body, and put it back byte for byte", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", { author: "luca", last_updated: "2026-11-14" }, "# Release\n\nTag first.");
    const text = await readFile(join(vaultPath, "curated/release.md"), "utf-8");

    const note = parseNote(text);

    expect(note).toEqual({ frontmatter: { type: "curated", author: "luca", last_updated: "2026-11-14" }, body: "# Release\n\nTag first." });
    expect(renderNote(note.frontmatter, note.body)).toBe(text);
  });

  it("read a file with no frontmatter as all body", () => {
    expect(parseNote("just text\n")).toEqual({ frontmatter: {}, body: "just text" });
  });
});

describe("readNote", () => {
  it("reads a curated note, a standard and a person's note by their vault paths", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", {}, "Tag first.");
    await writeToolCorrectionNote(vaultPath, "jira", "fields", { confidence: "low", derived_from: ["t1"], last_reviewed: null }, "Use --fields.");
    await writePersonalNote(vaultPath, "zitadel:1", "personal/notes/plan.md", {}, "My plan.");

    expect(await readNote(vaultPath, "curated/release.md")).toEqual({ frontmatter: { type: "curated" }, body: "Tag first." });
    expect((await readNote(vaultPath, "curated/standards/jira-fields.md"))?.body).toBe("Use --fields.");
    expect(await readNote(vaultPath, "users/zitadel%3A1/notes/plan.md")).toEqual({ frontmatter: { type: "personal" }, body: "My plan." });
  });

  it("is null for a note that isn't there", async () => {
    expect(await readNote(await makeTempVault(), "curated/nope.md")).toBeNull();
  });

  it("refuses a path outside curated/ and the people's notes: raw/, inferred/, review/, a way out", async () => {
    const vaultPath = await makeTempVault();
    for (const path of ["raw/x.md", "users/zitadel%3A1/inferred/team.md", "review/x.md", "curated/../raw/x.md", "index.md"]) {
      await expect(readNote(vaultPath, path)).rejects.toThrow(`not a note's path: ${path}`);
    }
  });
});

describe("updateNoteFrontmatter", () => {
  it("changes the frontmatter, keeps the body, and commits it", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", { author: "luca" }, "Tag first.");

    const changed = await updateNoteFrontmatter(vaultPath, "curated/release.md", (fm) => ({ ...fm, status: "verified", evidence: ["t1"] }), "status: release");

    expect(changed).toBe(true);
    expect(await readFile(join(vaultPath, "curated/release.md"), "utf-8")).toBe(
      "---\ntype: curated\nauthor: luca\nstatus: verified\nevidence:\n  - t1\n---\n\nTag first.\n",
    );
    expect((await gitLog(vaultPath))[0]).toBe("status: release");
  });

  it("is false, writing nothing, for a note that isn't there", async () => {
    const vaultPath = await makeTempVault();
    expect(await updateNoteFrontmatter(vaultPath, "curated/nope.md", (fm) => fm, "x")).toBe(false);
    expect(await Bun.file(join(vaultPath, "curated/nope.md")).exists()).toBe(false);
  });

  it("refuses a frontmatter its note's schema doesn't take, leaving the note as it was", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", {}, "Tag first.");
    const before = await readFile(join(vaultPath, "curated/release.md"), "utf-8");

    await expect(updateNoteFrontmatter(vaultPath, "curated/release.md", (fm) => ({ ...fm, status: "wrong" }), "x")).rejects.toThrow();

    expect(await readFile(join(vaultPath, "curated/release.md"), "utf-8")).toBe(before);
  });
});

describe("rewriteNoteBody", () => {
  it("replaces the body and the frontmatter as `change` makes it, when the note is still `expected`", async () => {
    const vaultPath = await makeTempVault();
    await writePersonalNote(vaultPath, "zitadel:1", "personal/notes/plan.md", { last_updated: "2026-11-01" }, "Old plan.");
    const path = "users/zitadel%3A1/notes/plan.md";
    const expected = (await readNote(vaultPath, path))!;

    const written = await rewriteNoteBody(vaultPath, path, expected, "New plan.", (fm) => ({ ...fm, status: "verified" }), "dreaming: plan");

    expect(written).toBe(true);
    expect(await readNote(vaultPath, path)).toEqual({ frontmatter: { type: "personal", last_updated: "2026-11-01", status: "verified" }, body: "New plan." });
  });

  // A person may change the note between the pass reading it and writing it: their change wins.
  it("writes nothing when the note changed since `expected` was read", async () => {
    const vaultPath = await makeTempVault();
    await writePersonalNote(vaultPath, "zitadel:1", "personal/notes/plan.md", {}, "Old plan.");
    const path = "users/zitadel%3A1/notes/plan.md";
    const expected = (await readNote(vaultPath, path))!;
    await writePersonalNote(vaultPath, "zitadel:1", "personal/notes/plan.md", {}, "The person's own edit.");

    expect(await rewriteNoteBody(vaultPath, path, expected, "New plan.", (fm) => fm, "x")).toBe(false);
    expect((await readNote(vaultPath, path))?.body).toBe("The person's own edit.");
  });
});
