import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCuratedNote, updateIndexFile } from "./wiki-note.ts";
import { initVault } from "./vault-init.ts";
import { findOrphanCuratedDocs } from "./orphan-detector.ts";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-orphan-detector-test-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("findOrphanCuratedDocs", () => {
  it("returns an empty list when curated/ is empty", async () => {
    const vaultPath = await makeTempVault();
    expect(await findOrphanCuratedDocs(vaultPath)).toEqual([]);
  });

  it("does not throw when index.md is missing, and flags every curated doc not otherwise cross-linked", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", {}, "body");

    const orphans = await findOrphanCuratedDocs(vaultPath);
    expect(orphans).toEqual(["curated/standards/jira-fields.md"]);
  });

  it("does not flag a doc mentioned in index.md", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", {}, "body");
    await updateIndexFile(vaultPath, () => "- [[standards/jira-fields]] — custom field conventions");

    const orphans = await findOrphanCuratedDocs(vaultPath);
    expect(orphans).toEqual([]);
  });

  it("does not flag a doc referenced via [[basename]] from another curated doc", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", {}, "body");
    await writeCuratedNote(vaultPath, "glossary.md", {}, "See [[jira-fields]] for details.");

    const orphans = await findOrphanCuratedDocs(vaultPath);
    expect(orphans).toEqual(["curated/glossary.md"]);
  });

  it("does not flag a doc referenced via [[curated-relative/path]] from another curated doc", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", {}, "body");
    await writeCuratedNote(vaultPath, "glossary.md", {}, "See [[standards/jira-fields]] for details.");

    const orphans = await findOrphanCuratedDocs(vaultPath);
    expect(orphans).toEqual(["curated/glossary.md"]);
  });

  it("does not count a doc's own self-link as being referenced", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", {}, "See also [[jira-fields]] above.");

    const orphans = await findOrphanCuratedDocs(vaultPath);
    expect(orphans).toEqual(["curated/standards/jira-fields.md"]);
  });

  it("flags a doc referenced by neither index.md nor any wikilink", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", {}, "body");
    await writeCuratedNote(vaultPath, "glossary.md", {}, "unrelated content");
    await updateIndexFile(vaultPath, () => "- [[standards/jira-fields]] — custom field conventions");

    const orphans = await findOrphanCuratedDocs(vaultPath);
    expect(orphans).toEqual(["curated/glossary.md"]);
  });
});
