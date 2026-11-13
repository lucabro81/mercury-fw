/**
 * The core's data folder: where Mercury keeps its own state (account links,
 * people's profiles, the plugins' data, traces and their secret), on a
 * volume of its own, apart from the wiki's vault. Its path is
 * `MERCURY_DATA_PATH`, required: without it the state would land inside the
 * container and be lost at the next restart, so the start stops instead.
 *
 * Before this folder existed the same state lived in `<vault>/.mercury/`;
 * `migrateLegacyState` copies it over once, on the first start with an
 * empty data folder.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** `MERCURY_DATA_PATH`, or an error saying what it is for when it isn't set. */
export function requireDataPath(env: Record<string, string | undefined>): string {
  const path = env.MERCURY_DATA_PATH;
  if (!path) {
    throw new Error(
      "MERCURY_DATA_PATH is not set: the folder, on a volume of its own, where Mercury keeps its state (account links, profiles, plugins' data, traces)",
    );
  }
  return path;
}

/** Where each plugin's `dataDir` lives, one folder per plugin. */
export function pluginDataRoot(dataPath: string): string {
  return resolve(dataPath, "plugins");
}

/** The entries of `dir`, sorted; none when it doesn't exist. */
async function entriesOf(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * Copies `<vaultPath>/.mercury/` into `dataPath` when the data folder is
 * empty (or missing) and there is a vault with one, leaving the original where it is,
 * and returns the names it copied. A data folder that already holds anything
 * is never touched, so this runs on every start and acts at most once.
 * Creates the data folder either way.
 *
 * A copy that fails removes what it had copied and throws: a half-filled
 * data folder would never be copied again, and starting without the links
 * and profiles would silently lose them. `copy` is a test seam.
 */
export async function migrateLegacyState(deps: {
  dataPath: string;
  /** The vault of an older instance; without one there is nothing to copy. */
  vaultPath?: string;
  log: (msg: string) => void;
  copy?: (from: string, to: string) => Promise<void>;
}): Promise<string[]> {
  const copy = deps.copy ?? ((from, to) => cp(from, to, { recursive: true, preserveTimestamps: true }));
  const target = resolve(deps.dataPath);
  await mkdir(target, { recursive: true });
  if (deps.vaultPath === undefined) return [];
  const legacy = resolve(deps.vaultPath, ".mercury");
  if ((await entriesOf(target)).length > 0) return [];
  const entries = await entriesOf(legacy);
  if (entries.length === 0) return [];
  try {
    for (const entry of entries) await copy(resolve(legacy, entry), resolve(target, entry));
  } catch (err) {
    for (const entry of await entriesOf(target)) await rm(resolve(target, entry), { recursive: true, force: true });
    throw new Error(`couldn't copy Mercury's state from ${legacy} to ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
  deps.log(`copied Mercury's state from ${legacy} to ${target} (${entries.join(", ")}); the original is left where it is`);
  return entries;
}
