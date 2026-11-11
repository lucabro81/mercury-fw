import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateLegacyState, pluginDataRoot, requireDataPath } from "./data-dir.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-data-"));
  tempDirs.push(dir);
  return dir;
}

/** A vault holding `files` under `.mercury/`, as before the data folder had a volume of its own. */
async function legacyVault(files: Record<string, string>): Promise<string> {
  const vault = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(vault, ".mercury", path)), { recursive: true });
    await writeFile(join(vault, ".mercury", path), content);
  }
  return vault;
}

describe("requireDataPath", () => {
  it("returns MERCURY_DATA_PATH", () => {
    expect(requireDataPath({ MERCURY_DATA_PATH: "/app/data" })).toBe("/app/data");
  });

  it("stops the start when it isn't set, saying what it is for", () => {
    expect(() => requireDataPath({})).toThrow(
      "MERCURY_DATA_PATH is not set: the folder, on a volume of its own, where Mercury keeps its state (account links, profiles, plugins' data, traces)",
    );
  });

  it("treats an empty value as not set", () => {
    expect(() => requireDataPath({ MERCURY_DATA_PATH: "" })).toThrow("MERCURY_DATA_PATH is not set");
  });
});

describe("pluginDataRoot", () => {
  it("is plugins/ in the data folder", () => {
    expect(pluginDataRoot("/app/data")).toBe("/app/data/plugins");
  });
});

describe("migrateLegacyState", () => {
  it("copies the vault's .mercury/ into an empty data folder and keeps the original", async () => {
    const vault = await legacyVault({
      "identity-links.json": '{"links":[]}',
      "profiles.json": '{"a":{}}',
      "plugins/web-search/hosts.json": "[]",
      "traces/2026-11-11.jsonl": "{}\n",
      "trace-secret": "ab".repeat(32),
    });
    const data = join(await tempDir(), "data");
    const logs: string[] = [];

    const copied = await migrateLegacyState({ dataPath: data, vaultPath: vault, log: (m) => logs.push(m) });

    expect(copied).toEqual(["identity-links.json", "plugins", "profiles.json", "trace-secret", "traces"]);
    expect(await readFile(join(data, "identity-links.json"), "utf8")).toBe('{"links":[]}');
    expect(await readFile(join(data, "plugins/web-search/hosts.json"), "utf8")).toBe("[]");
    expect(await readFile(join(data, "traces/2026-11-11.jsonl"), "utf8")).toBe("{}\n");
    expect(await readFile(join(data, "trace-secret"), "utf8")).toBe("ab".repeat(32));
    // The original stays, so going back to the previous version still finds it.
    expect((await readdir(join(vault, ".mercury"))).sort()).toEqual(copied);
    expect(logs).toEqual([
      `copied Mercury's state from ${join(vault, ".mercury")} to ${data} (identity-links.json, plugins, profiles.json, trace-secret, traces); the original is left where it is`,
    ]);
  });

  it("keeps the trace secret readable only by its owner", async () => {
    const vault = await legacyVault({ "trace-secret": "ab".repeat(32) });
    const { chmod } = await import("node:fs/promises");
    await chmod(join(vault, ".mercury", "trace-secret"), 0o600);
    const data = await tempDir();

    await migrateLegacyState({ dataPath: data, vaultPath: vault, log: () => {} });

    expect((await stat(join(data, "trace-secret"))).mode & 0o777).toBe(0o600);
  });

  it("leaves a data folder that already holds something untouched", async () => {
    const vault = await legacyVault({ "profiles.json": '{"old":{}}' });
    const data = await tempDir();
    await writeFile(join(data, "profiles.json"), '{"new":{}}');
    const logs: string[] = [];

    const copied = await migrateLegacyState({ dataPath: data, vaultPath: vault, log: (m) => logs.push(m) });

    expect(copied).toEqual([]);
    expect(await readFile(join(data, "profiles.json"), "utf8")).toBe('{"new":{}}');
    expect(logs).toEqual([]);
  });

  it("is idempotent: a second run copies nothing", async () => {
    const vault = await legacyVault({ "profiles.json": "{}" });
    const data = await tempDir();
    await migrateLegacyState({ dataPath: data, vaultPath: vault, log: () => {} });

    expect(await migrateLegacyState({ dataPath: data, vaultPath: vault, log: () => {} })).toEqual([]);
  });

  it("does nothing when the vault has no .mercury/, creating the data folder", async () => {
    const vault = await tempDir();
    const data = join(await tempDir(), "data");

    expect(await migrateLegacyState({ dataPath: data, vaultPath: vault, log: () => {} })).toEqual([]);
    expect(await readdir(data)).toEqual([]);
  });

  it("does nothing when the vault's .mercury/ is empty", async () => {
    const vault = await tempDir();
    await mkdir(join(vault, ".mercury"));
    const data = await tempDir();

    expect(await migrateLegacyState({ dataPath: data, vaultPath: vault, log: () => {} })).toEqual([]);
  });

  it("a copy that fails halfway leaves the data folder empty and stops the start, so the next start tries again", async () => {
    const vault = await legacyVault({ "identity-links.json": "{}", "profiles.json": "{}", "traces/a.jsonl": "" });
    const data = await tempDir();
    const { cp } = await import("node:fs/promises");
    const copy = async (from: string, to: string) => {
      if (from.endsWith("profiles.json")) throw new Error("disk full");
      await cp(from, to, { recursive: true });
    };

    await expect(migrateLegacyState({ dataPath: data, vaultPath: vault, log: () => {}, copy })).rejects.toThrow(
      `couldn't copy Mercury's state from ${join(vault, ".mercury")} to ${data}: disk full`,
    );
    expect(await readdir(data)).toEqual([]);
    expect(await migrateLegacyState({ dataPath: data, vaultPath: vault, log: () => {} })).toEqual([
      "identity-links.json",
      "profiles.json",
      "traces",
    ]);
  });

  it("does nothing when the data folder is the vault's own .mercury/", async () => {
    // An app pointing MERCURY_DATA_PATH at the old place keeps its state there.
    const vault = await legacyVault({ "profiles.json": "{}" });

    expect(await migrateLegacyState({ dataPath: join(vault, ".mercury"), vaultPath: vault, log: () => {} })).toEqual([]);
  });
});
