import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initVault } from "./vault-init.ts";
import { migrateVaultToUserAreas } from "./vault-layout.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

const confirmed = "---\ntype: confirmation\nstatus: confirmed\n---\n";

/** A vault in the layout before per-person areas, committed. */
async function legacyVault(files: Record<string, string>): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "mercury-migrate-"));
  tempDirs.push(vault);
  await initVault(vault);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    await writeFile(join(vault, path), content);
  }
  await git(vault, "add", "-A");
  await git(vault, "commit", "-qm", "legacy");
  return vault;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("migrateVaultToUserAreas", () => {
  it("moves Google Chat and terminal people's inferred notes into their areas, in one commit", async () => {
    const vault = await legacyVault({
      "curated/team.md": "team",
      "inferred/users/users%2F42/team.md": "platform",
      "inferred/users/users%252F42/role.md": "developer",
      "inferred/users/terminal/team.md": "ops",
    });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(await readFile(join(vault, "users/google-chat%3Ausers%2F42/inferred/team.md"), "utf-8")).toBe("platform");
    expect(await readFile(join(vault, "users/google-chat%3Ausers%2F42/inferred/role.md"), "utf-8")).toBe("developer");
    expect(await readFile(join(vault, "users/none%3Aterminal/inferred/team.md"), "utf-8")).toBe("ops");
    expect(await exists(join(vault, "inferred"))).toBe(false);
    expect(await readFile(join(vault, "curated/team.md"), "utf-8")).toBe("team");
    expect(await git(vault, "log", "--format=%s")).toBe("migrate: per-person notes into users/<key>/\nlegacy");
    expect(await git(vault, "status", "--porcelain")).toBe("");
    expect(logs).toEqual(["moved 3 notes of 2 people into users/<key>/"]);
  });

  // The confirmation notes live in Mercury's data folder now: the old layout's
  // stay where they are, read by nothing.
  it("leaves the old layout's confirmation notes where they are", async () => {
    const vault = await legacyVault({ "inferred/confirmations/users%2F42/aaaa-1111.md": confirmed });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(await readFile(join(vault, "inferred/confirmations/users%2F42/aaaa-1111.md"), "utf-8")).toBe(confirmed);
    expect(await exists(join(vault, "users/google-chat%3Ausers%2F42/confirmations"))).toBe(false);
    expect(logs).toEqual([]);
    expect(await git(vault, "log", "--format=%s")).toBe("legacy");
  });

  it("says which legacy note it dropped because the area already had one", async () => {
    const vault = await legacyVault({
      "users/google-chat%3Ausers%2F42/inferred/team.md": "current",
      "inferred/users/users%2F42/team.md": "older",
    });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(await readFile(join(vault, "users/google-chat%3Ausers%2F42/inferred/team.md"), "utf-8")).toBe("current");
    expect(logs).toEqual([
      "dropped inferred/users/users%2F42/team.md: users/google-chat%3Ausers%2F42/inferred/team.md already exists (the vault's git history keeps it)",
    ]);
  });

  it("leaves what it can't attribute where it is, and says so", async () => {
    const vault = await legacyVault({
      "inferred/users/alice/team.md": "x",
    });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(await readFile(join(vault, "inferred/users/alice/team.md"), "utf-8")).toBe("x");
    expect(logs).toEqual([
      'left inferred/users/alice in place: can\'t tell whose it is (an id without its provider)',
    ]);
    expect(await git(vault, "log", "--format=%s")).toBe("legacy");
  });

  it("does nothing, and commits nothing, on a vault already in the new layout or run twice", async () => {
    const vault = await legacyVault({ "inferred/users/users%2F42/team.md": "platform" });
    await migrateVaultToUserAreas(vault, () => {});
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(logs).toEqual([]);
    expect((await git(vault, "log", "--format=%s")).split("\n")).toHaveLength(2);
  });
});
