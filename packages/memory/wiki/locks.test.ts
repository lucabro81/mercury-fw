import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLockPaths, createLockCheck } from "./locks.ts";
import { initVault } from "./vault-init.ts";
import { writeCuratedNote, writePersonalNote } from "./wiki-note.ts";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-locks-test-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("assertLockPaths", () => {
  it("takes paths under curated/", () => {
    expect(() => assertLockPaths(["curated/confluence/**", "curated/policy.md"])).not.toThrow();
  });

  it("refuses a path outside curated/, naming it: a person's notes are locked by the person, nothing else carries a lock", () => {
    for (const path of ["users/**", "raw/**", "**", "curated", "personal/notes/x.md"]) {
      expect(() => assertLockPaths([path])).toThrow(`wiki: locked takes paths under curated/ (got "${path}")`);
    }
  });
});

describe("createLockCheck", () => {
  it("is true for a note whose frontmatter says locked, curated or a person's", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "policy.md", { locked: true }, "Policy.");
    await writePersonalNote(vaultPath, "zitadel:1", "personal/notes/plan.md", {}, "Plan.");
    const isLocked = createLockCheck(vaultPath, []);

    expect(await isLocked("curated/policy.md")).toBe(true);
    expect(await isLocked("users/zitadel%3A1/notes/plan.md")).toBe(false);
  });

  it("is true for a curated note under a configured path, whatever its frontmatter", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "confluence/space/page.md", {}, "Synced.");
    await writeCuratedNote(vaultPath, "release.md", {}, "Ours.");
    const isLocked = createLockCheck(vaultPath, ["curated/confluence/**"]);

    expect(await isLocked("curated/confluence/space/page.md")).toBe(true);
    expect(await isLocked("curated/release.md")).toBe(false);
  });

  it("is true for a path under a configured one even before the note exists, so a write can't create it", async () => {
    const isLocked = createLockCheck(await makeTempVault(), ["curated/confluence/**"]);
    expect(await isLocked("curated/confluence/new.md")).toBe(true);
    expect(await isLocked("curated/new.md")).toBe(false);
  });

  // A note whose frontmatter can't be read might be a locked one: the review must not write over it.
  it("is true for a note it can't read the frontmatter of", async () => {
    const vaultPath = await makeTempVault();
    await Bun.write(join(vaultPath, "curated/policy.md"), "---\nlocked: [unclosed\n---\n\nPolicy.\n");
    expect(await createLockCheck(vaultPath, [])("curated/policy.md")).toBe(true);
  });

  it("is false for a note that isn't there and no configured path covers", async () => {
    expect(await createLockCheck(await makeTempVault(), [])("curated/nope.md")).toBe(false);
  });
});
