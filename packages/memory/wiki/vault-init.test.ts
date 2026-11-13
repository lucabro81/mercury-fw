import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "./vault-init.ts";

const tempDirs: string[] = [];

async function makeTempVaultPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-vault-test-"));
  tempDirs.push(dir);
  return join(dir, "wiki-vault");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("initVault", () => {
  it("creates the curated subdirectories", async () => {
    const vaultPath = await makeTempVaultPath();
    await initVault(vaultPath);

    for (const sub of ["curated/design", "curated/standards", "curated/decisions"]) {
      const s = await stat(join(vaultPath, sub));
      expect(s.isDirectory()).toBe(true);
    }
  });

  it("creates the users directory, where each person gets an area", async () => {
    const vaultPath = await makeTempVaultPath();
    await initVault(vaultPath);

    const s = await stat(join(vaultPath, "users"));
    expect(s.isDirectory()).toBe(true);
  });

  it("creates the raw/ directory (human-only inbox for un-triaged material)", async () => {
    const vaultPath = await makeTempVaultPath();
    await initVault(vaultPath);

    const s = await stat(join(vaultPath, "raw"));
    expect(s.isDirectory()).toBe(true);
  });

  it("git-inits the vault if it isn't already a git repo", async () => {
    const vaultPath = await makeTempVaultPath();
    await initVault(vaultPath);

    const s = await stat(join(vaultPath, ".git"));
    expect(s.isDirectory()).toBe(true);
  });

  it("is idempotent — running twice does not throw or duplicate the git repo", async () => {
    const vaultPath = await makeTempVaultPath();
    await initVault(vaultPath);
    await initVault(vaultPath); // should not throw

    const s = await stat(join(vaultPath, ".git"));
    expect(s.isDirectory()).toBe(true);
  });

  it("does not fail if the vault path already exists with unrelated content", async () => {
    const vaultPath = await makeTempVaultPath();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(vaultPath, { recursive: true });
    await writeFile(join(vaultPath, "README.md"), "pre-existing file");

    await initVault(vaultPath); // should not throw, should not remove README.md

    const s = await stat(join(vaultPath, "README.md"));
    expect(s.isFile()).toBe(true);
  });

  // #190: Mercury's own files on the vault's volume (the account links) never
  // land in the vault's git, whatever stages everything.
  it("keeps .mercury/ out of the vault's git, once, through the repo's own exclude", async () => {
    const vaultPath = await makeTempVaultPath();
    await initVault(vaultPath);
    await initVault(vaultPath);
    const exclude = await readFile(join(vaultPath, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.mercury/")).toHaveLength(1);
    await mkdir(join(vaultPath, ".mercury"), { recursive: true });
    await writeFile(join(vaultPath, ".mercury", "identity-links.json"), "{}");
    const proc = Bun.spawn(["git", "status", "--porcelain", "--ignored=no"], { cwd: vaultPath, stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).not.toContain(".mercury");
  });
});
