import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grepVisible, listVisible, personalNotePath, readVisible } from "./vault-access.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

const ALICE = "static:alice";
const BOB = "static:bob";

/** A vault holding the common area, two people's areas, a raw entry, the index and a file outside the vault. */
async function seededVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mercury-vault-access-"));
  tempDirs.push(root);
  const vault = join(root, "vault");
  const files: Record<string, string> = {
    "curated/standards/jira.md": "team convention: alpha",
    "users/static%3Aalice/notes/plan.md": "alice plan: alpha",
    "users/static%3Aalice/inferred/work_style.md": "alice works in batches",
    "users/static%3Aalice/confirmations/abcd-1234.md": "status: pending",
    "users/static%3Abob/notes/secret.md": "bob secret: alpha",
    "raw/inbox.md": "raw alpha",
    "index.md": "index alpha",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    await writeFile(join(vault, path), content);
  }
  await writeFile(join(root, "outside.md"), "outside alpha");
  return vault;
}

describe("listVisible", () => {
  it("lists the common area and the person's own notes and inferred notes, under the personal/ alias", async () => {
    const vaultPath = await seededVault();
    expect(await listVisible({ vaultPath, key: ALICE })).toEqual([
      "curated/standards/jira.md",
      "personal/inferred/work_style.md",
      "personal/notes/plan.md",
    ]);
  });

  it("never lists another person's area, confirmations, raw/ or the index", async () => {
    const vaultPath = await seededVault();
    expect(await listVisible({ vaultPath, key: BOB })).toEqual(["curated/standards/jira.md", "personal/notes/secret.md"]);
  });

  it("lists only the common area for someone with no area yet", async () => {
    const vaultPath = await seededVault();
    expect(await listVisible({ vaultPath, key: "oidc:carol" })).toEqual(["curated/standards/jira.md"]);
  });
});

describe("readVisible", () => {
  it("reads the common area and the person's own area through the alias", async () => {
    const vaultPath = await seededVault();
    const scope = { vaultPath, key: ALICE };
    expect(await readVisible(scope, "curated/standards/jira.md")).toBe("team convention: alpha");
    expect(await readVisible(scope, "personal/notes/plan.md")).toBe("alice plan: alpha");
    expect(await readVisible(scope, "personal/inferred/work_style.md")).toBe("alice works in batches");
  });

  it("refuses everything else as if it didn't exist, naming only the path asked for", async () => {
    const vaultPath = await seededVault();
    const scope = { vaultPath, key: BOB };
    for (const path of [
      "users/static%3Aalice/notes/plan.md",
      "users/static%3Abob/notes/secret.md",
      "personal/../users/static%3Aalice/notes/plan.md",
      "curated/../users/static%3Aalice/notes/plan.md",
      "personal/confirmations/abcd-1234.md",
      "raw/inbox.md",
      "index.md",
      "../outside.md",
      "curated/../../outside.md",
      "/etc/hosts",
      "personal",
      "",
    ]) {
      await expect(readVisible(scope, path)).rejects.toThrow(`path not accessible: ${path}`);
    }
  });
});

describe("grepVisible", () => {
  it("searches only what the person can see, case-insensitively, and reports the paths they'd use to read", async () => {
    const vaultPath = await seededVault();
    expect(await grepVisible({ vaultPath, key: ALICE }, "ALPHA")).toEqual([
      { path: "curated/standards/jira.md", line: 1, text: "team convention: alpha" },
      { path: "personal/notes/plan.md", line: 1, text: "alice plan: alpha" },
    ]);
  });
});

describe("personalNotePath", () => {
  it("maps a path under personal/notes/ onto the person's notes folder", () => {
    expect(personalNotePath("/v", ALICE, "personal/notes/plan.md")).toBe("/v/users/static%3Aalice/notes/plan.md");
    expect(personalNotePath("/v", ALICE, "personal/notes/a/b.md")).toBe("/v/users/static%3Aalice/notes/a/b.md");
  });

  it("points a write to the common area at promote_note", () => {
    expect(() => personalNotePath("/v", ALICE, "curated/x.md")).toThrow(
      "curated/ is the common area: write under personal/notes/ and use promote_note to share it",
    );
  });

  it("refuses anything outside personal/notes/, escapes included", () => {
    for (const path of [
      "personal/inferred/work_style.md",
      "personal/confirmations/abcd-1234.md",
      "personal/notes/../inferred/x.md",
      "personal/notes/../../static%3Abob/notes/x.md",
      "personal/notes",
      "personal/notes/",
      "raw/x.md",
      "x.md",
    ]) {
      expect(() => personalNotePath("/v", ALICE, path)).toThrow(`not writable: ${path} (write under personal/notes/)`);
    }
  });
});
