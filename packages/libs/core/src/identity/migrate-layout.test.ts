import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initVault } from "../wiki/vault-init.ts";
import { legacyUserKey, migrateMemoryToUserKeys, migrateVaultToUserAreas, type MigrationQdrant } from "./migrate-layout.ts";

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

const pending = "---\ntype: confirmation\nstatus: pending\n---\n";
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

describe("legacyUserKey", () => {
  it("attributes a Google Chat id, encoded once, twice or not at all, and the terminal", () => {
    expect(legacyUserKey("users/42")).toBe("google-chat:users/42");
    expect(legacyUserKey("users%2F42")).toBe("google-chat:users/42");
    expect(legacyUserKey("users%252F42")).toBe("google-chat:users/42");
    expect(legacyUserKey("terminal")).toBe("none:terminal");
  });

  it("can't attribute anything else: an id without its provider could be anyone's", () => {
    for (const id of ["alice", "conv-1", "users/42/x", "users/", "%E0%A4%A", "static:alice", "google-chat:users/42"]) {
      expect(legacyUserKey(id)).toBeUndefined();
    }
  });
});

describe("migrateVaultToUserAreas", () => {
  it("moves a Google Chat person's inferred notes and confirmations into their area, in one commit", async () => {
    const vault = await legacyVault({
      "curated/team.md": "team",
      "inferred/users/users%2F42/team.md": "platform",
      "inferred/confirmations/users%2F42/aaaa-1111.md": confirmed,
      "inferred/confirmations/terminal/bbbb-2222.md": pending,
    });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(await readFile(join(vault, "users/google-chat%3Ausers%2F42/inferred/team.md"), "utf-8")).toBe("platform");
    expect(await readFile(join(vault, "users/google-chat%3Ausers%2F42/confirmations/aaaa-1111.md"), "utf-8")).toBe(confirmed);
    expect(await readFile(join(vault, "users/none%3Aterminal/confirmations/bbbb-2222.md"), "utf-8")).toBe(pending);
    expect(await exists(join(vault, "inferred"))).toBe(false);
    expect(await readFile(join(vault, "curated/team.md"), "utf-8")).toBe("team");
    expect(await git(vault, "log", "--format=%s")).toBe("migrate: per-person notes into users/<key>/\nlegacy");
    expect(await git(vault, "status", "--porcelain")).toBe("");
    expect(logs).toEqual(["moved 3 notes of 2 people into users/<key>/"]);
  });

  // The double encoding left a staged note "pending" in one folder and its
  // resolution in another: merged, the resolved one is the truth.
  it("merges the twice-encoded confirmations folder into the same area, keeping the resolved note over a stale pending one", async () => {
    const vault = await legacyVault({
      "inferred/confirmations/users%252F42/aaaa-1111.md": pending,
      "inferred/confirmations/users%2F42/aaaa-1111.md": confirmed,
      "inferred/confirmations/users%252F42/cccc-3333.md": pending,
    });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    const area = join(vault, "users/google-chat%3Ausers%2F42/confirmations");
    expect(await readFile(join(area, "aaaa-1111.md"), "utf-8")).toBe(confirmed);
    expect(await readFile(join(area, "cccc-3333.md"), "utf-8")).toBe(pending);
    expect(await exists(join(vault, "inferred"))).toBe(false);
    // Two notes end up in the area, whichever copy of the first one won.
    expect(logs).toEqual(["moved 2 notes of 1 person into users/<key>/"]);
  });

  it("says which legacy note it dropped because the area already had one, other than a stale pending confirmation", async () => {
    const vault = await legacyVault({
      "users/google-chat%3Ausers%2F42/inferred/team.md": "current",
      "inferred/users/users%2F42/team.md": "older",
      "inferred/confirmations/users%252F42/aaaa-1111.md": pending,
      "inferred/confirmations/users%2F42/aaaa-1111.md": confirmed,
    });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(await readFile(join(vault, "users/google-chat%3Ausers%2F42/inferred/team.md"), "utf-8")).toBe("current");
    expect(logs).toEqual([
      "dropped inferred/users/users%2F42/team.md: users/google-chat%3Ausers%2F42/inferred/team.md already exists (the vault's git history keeps it)",
      "moved 1 note of 1 person into users/<key>/",
    ]);
  });

  it("leaves what it can't attribute where it is, and says so", async () => {
    const vault = await legacyVault({
      "inferred/users/alice/team.md": "x",
      "inferred/confirmations/conv-1/dddd-4444.md": pending,
    });
    const logs: string[] = [];

    await migrateVaultToUserAreas(vault, (m) => logs.push(m));

    expect(await readFile(join(vault, "inferred/users/alice/team.md"), "utf-8")).toBe("x");
    expect(await exists(join(vault, "inferred/confirmations/conv-1/dddd-4444.md"))).toBe(true);
    expect(logs).toEqual([
      'left inferred/users/alice in place: can\'t tell whose it is (an id without its provider)',
      'left inferred/confirmations/conv-1 in place: can\'t tell whose it is (an id without its provider)',
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

/** A Qdrant fake holding `points` per collection, paging scrolls by `pageSize`, recording every setPayload. */
function fakeQdrant(points: Record<string, string[]>, pageSize = 2) {
  const updates: Array<{ collection: string; userId: string; key: string }> = [];
  const client: MigrationQdrant = {
    scroll: async (collection, params) => {
      const all = points[collection];
      if (all === undefined) throw new Error(`Not found: Collection ${collection} doesn't exist`);
      const start = typeof params.offset === "number" ? params.offset : 0;
      const page = all.slice(start, start + pageSize);
      return {
        points: page.map((userId, i) => ({ id: start + i, payload: { userId } })),
        next_page_offset: start + pageSize < all.length ? start + pageSize : null,
      };
    },
    setPayload: async (collection, params) => {
      const userId = params.filter.must[0]!.match.value;
      const key = params.payload.userId;
      updates.push({ collection, userId, key });
      points[collection] = points[collection]!.map((u) => (u === userId ? key : u));
      return {};
    },
  };
  return { client, updates };
}

describe("migrateMemoryToUserKeys", () => {
  const collections = ["episodic_memory", "semantic_facts", "verbatim_archive"];

  it("rewrites every legacy userId it can attribute to its user key, across pages and collections", async () => {
    const { client, updates } = fakeQdrant({
      episodic_memory: ["users/42", "users/42", "users/7"],
      semantic_facts: ["users/42"],
      // The archive stored the id encoded.
      verbatim_archive: ["users%2F42", "users%2F42", "users%2F7"],
    });
    const logs: string[] = [];

    await migrateMemoryToUserKeys(client, collections, (m) => logs.push(m));

    expect(updates).toEqual([
      { collection: "episodic_memory", userId: "users/42", key: "google-chat:users/42" },
      { collection: "episodic_memory", userId: "users/7", key: "google-chat:users/7" },
      { collection: "semantic_facts", userId: "users/42", key: "google-chat:users/42" },
      { collection: "verbatim_archive", userId: "users%2F42", key: "google-chat:users/42" },
      { collection: "verbatim_archive", userId: "users%2F7", key: "google-chat:users/7" },
    ]);
    expect(logs).toEqual(["rewrote 5 legacy userIds to user keys"]);
  });

  it("leaves user keys alone and what it can't attribute, saying so once per id", async () => {
    const { client, updates } = fakeQdrant({
      episodic_memory: ["google-chat:users/42", "alice", "alice"],
      semantic_facts: [],
      verbatim_archive: ["static:bob"],
    });
    const logs: string[] = [];

    await migrateMemoryToUserKeys(client, collections, (m) => logs.push(m));

    expect(updates).toEqual([]);
    expect(logs).toEqual(['episodic_memory: left userId "alice" as it is: can\'t tell whose it is (an id without its provider)']);
  });

  it("goes on with the other collections when one fails, and says which", async () => {
    const { client, updates } = fakeQdrant({ semantic_facts: ["users/42"], verbatim_archive: [] });
    const logs: string[] = [];

    await migrateMemoryToUserKeys(client, collections, (m) => logs.push(m));

    expect(updates).toEqual([{ collection: "semantic_facts", userId: "users/42", key: "google-chat:users/42" }]);
    expect(logs[0]).toStartWith("episodic_memory: migration skipped: ");
    expect(logs[1]).toBe("rewrote 1 legacy userIds to user keys");
  });
});
