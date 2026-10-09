/**
 * Idempotent scaffolding for the wiki vault (Layer 2) — the vault itself
 * is a separate git repository, mounted as an external volume
 * (`wiki-vault:/app/wiki-vault` in docker-compose.yml), not part of
 * Mercury's own repo. This runs at Mercury startup against
 * `WIKI_VAULT_PATH` to make sure the expected curated/users/raw structure
 * and the vault's own git repo exist, without disturbing whatever
 * content is already there.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SUBDIRS = ["curated/design", "curated/standards", "curated/decisions", "users", "raw"];

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the vault's curated/users/raw subdirectories and git-inits the
 * vault if it isn't already a git repo. Safe to call on every startup:
 * pre-existing directories/content are left untouched, and re-running
 * `git init` on an already-initialized repo is a no-op.
 */
/** Mercury's own files on the vault's volume, as a path the vault's git excludes. */
const MERCURY_DIR = "/.mercury/";

export async function initVault(vaultPath: string): Promise<void> {
  for (const sub of SUBDIRS) {
    await mkdir(join(vaultPath, sub), { recursive: true });
  }

  if (!(await pathExists(join(vaultPath, ".git")))) {
    const proc = Bun.spawn(["git", "init"], { cwd: vaultPath, stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git init failed in ${vaultPath}: ${stderr}`);
    }
  }

  // Mercury's own files on this volume (the account links) stay out of the
  // vault's history, whatever stages everything.
  const exclude = join(vaultPath, ".git", "info", "exclude");
  const current = (await pathExists(exclude)) ? await readFile(exclude, "utf8") : "";
  if (!current.split("\n").includes(MERCURY_DIR)) {
    await mkdir(join(vaultPath, ".git", "info"), { recursive: true });
    await writeFile(exclude, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${MERCURY_DIR}\n`);
  }
}
