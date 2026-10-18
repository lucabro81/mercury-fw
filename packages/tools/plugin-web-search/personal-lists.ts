/**
 * The hosts each person allowed for themselves ("always for this host"), on
 * top of the instance's list. One JSON file per person in the plugin's data
 * folder (`<dataDir>/allowlist/<encoded key>.json`), so a list survives a
 * restart and never reaches the wiki. A file is replaced whole through a
 * temporary file and a rename, so a reader never sees half of one. What is
 * read back is checked again: a damaged file counts as an empty list, and an
 * entry that isn't an acceptable host is ignored.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHostEntry } from "./hosts.ts";

export type PersonalLists = {
  /** The hosts `personKey` allowed, in the order they were added. */
  hostsOf(personKey: string): Promise<string[]>;
  /** Adds `host` to `personKey`'s list; a host already there is kept once. */
  add(personKey: string, host: string): Promise<void>;
};

/** The lists kept under `dataDir`. */
export function createPersonalLists(dataDir: string): PersonalLists {
  const folder = join(dataDir, "allowlist");
  // A user key holds ":" and "/" (google-chat:users/42): encoded, it's one flat file name.
  const fileOf = (personKey: string) => join(folder, `${encodeURIComponent(personKey)}.json`);

  async function hostsOf(personKey: string): Promise<string[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(fileOf(personKey), "utf8"));
    } catch {
      return [];
    }
    const hosts = (raw as { hosts?: unknown })?.hosts;
    if (!Array.isArray(hosts)) return [];
    return hosts.flatMap((h) => {
      if (typeof h !== "string") return [];
      const parsed = parseHostEntry(h);
      return parsed.ok ? [parsed.host] : [];
    });
  }

  return {
    hostsOf,
    async add(personKey, host) {
      const hosts = await hostsOf(personKey);
      if (hosts.includes(host)) return;
      await mkdir(folder, { recursive: true });
      const file = fileOf(personKey);
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ hosts: [...hosts, host] }, null, 2));
      await rename(temp, file);
    },
  };
}
