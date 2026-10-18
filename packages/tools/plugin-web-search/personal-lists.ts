/**
 * The hosts each person allowed for themselves ("always for this host"), on
 * top of the instance's list. One JSON file per person in the plugin's data
 * folder (`<dataDir>/allowlist/<encoded key>.json`), so a list survives a
 * restart and never reaches the wiki. A file is replaced whole through a
 * temporary file and a rename, so a reader never sees half of one. What is
 * read back is checked again: a damaged file counts as an empty list, and an
 * entry that isn't an acceptable host is ignored. A file that can't be read
 * at all is never overwritten.
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

  /** The hosts in `personKey`'s file. A missing or damaged file is an empty
   * list; a file that can't be read throws when `strict`, so an add never
   * overwrites a list it couldn't see. */
  async function readHosts(personKey: string, strict: boolean): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(fileOf(personKey), "utf8");
    } catch (err) {
      if (!strict || (err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
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

  /** Reads, extends and replaces `personKey`'s file. */
  async function append(personKey: string, host: string): Promise<void> {
    const hosts = await readHosts(personKey, true);
    if (hosts.includes(host)) return;
    await mkdir(folder, { recursive: true });
    const file = fileOf(personKey);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ hosts: [...hosts, host] }, null, 2));
    await rename(temp, file);
  }

  // One add at a time per person: two at once would each read the old list and one host would be lost.
  const queues = new Map<string, Promise<void>>();

  return {
    hostsOf: (personKey) => readHosts(personKey, false),
    add(personKey, host) {
      const next = (queues.get(personKey) ?? Promise.resolve()).catch(() => {}).then(() => append(personKey, host));
      queues.set(personKey, next);
      return next;
    },
  };
}
