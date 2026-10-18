/**
 * The hosts each person allowed for themselves ("always for this host"), on
 * top of the instance's list. One JSON file per person in the plugin's data
 * folder (`<dataDir>/allowlist/<encoded key>.json`), so a list survives a
 * restart and never reaches the wiki. A file is replaced whole through a
 * temporary file and a rename, so a reader never sees half of one. What is
 * read back is checked again: a damaged file, or one that isn't a list of
 * hosts, counts as an empty list, and an entry that isn't an acceptable host
 * is ignored; either way a copy of the file is kept, as
 * `<file>.corrupt-<time>-<id>`, before the next host replaces it. A file that can't be read
 * at all is never overwritten.
 */
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHostEntry } from "./hosts.ts";

export type PersonalLists = {
  /** The hosts `personKey` allowed, in the order they were added. */
  hostsOf(personKey: string): Promise<string[]>;
  /** Adds `host` to `personKey`'s list; a host already there is kept once. */
  add(personKey: string, host: string): Promise<void>;
};

/** The lists kept under `dataDir`; `deps.writeFile` replaces the write, for tests. */
export function createPersonalLists(dataDir: string, deps: { writeFile?: typeof writeFile } = {}): PersonalLists {
  const write = deps.writeFile ?? writeFile;
  const folder = join(dataDir, "allowlist");
  // A user key holds ":" and "/" (google-chat:users/42): encoded, it's one flat file name.
  const fileOf = (personKey: string) => join(folder, `${encodeURIComponent(personKey)}.json`);

  /** The hosts in `personKey`'s file, and whether it was damaged (not JSON,
   * not a list of hosts, or with entries that aren't hosts). A missing or
   * damaged file gives what can be read of it; a file that can't be read
   * throws when `strict`, so an add never overwrites a list it couldn't see. */
  async function readHosts(personKey: string, strict: boolean): Promise<{ hosts: string[]; damaged: boolean }> {
    let text: string;
    try {
      text = await readFile(fileOf(personKey), "utf8");
    } catch (err) {
      if (!strict || (err as NodeJS.ErrnoException).code === "ENOENT") return { hosts: [], damaged: false };
      throw err;
    }
    let hosts: unknown;
    try {
      hosts = (JSON.parse(text) as { hosts?: unknown } | null)?.hosts;
    } catch {
      hosts = undefined;
    }
    if (!Array.isArray(hosts)) return { hosts: [], damaged: true };
    const valid = hosts.flatMap((h) => {
      if (typeof h !== "string") return [];
      const parsed = parseHostEntry(h);
      return parsed.ok ? [parsed.host] : [];
    });
    // An entry that isn't a host any more (hand-edited, or a suffix refused since) counts as damage too.
    return { hosts: valid, damaged: valid.length < hosts.length };
  }

  /** Reads, extends and replaces `personKey`'s file. */
  async function append(personKey: string, host: string): Promise<void> {
    const { hosts, damaged } = await readHosts(personKey, true);
    // A damaged file is rewritten clean, even when the host is already in it.
    if (hosts.includes(host) && !damaged) return;
    const next = hosts.includes(host) ? hosts : [...hosts, host];
    await mkdir(folder, { recursive: true });
    const file = fileOf(personKey);
    // A copy of what was there first, so nothing in it is lost for good; the
    // file itself stays in place until the new one replaces it.
    if (damaged) await copyFile(file, `${file}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await write(temp, JSON.stringify({ hosts: next }, null, 2));
      await rename(temp, file);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  // One add at a time per person: two at once would each read the old list and one host would be lost.
  const queues = new Map<string, Promise<void>>();

  return {
    hostsOf: async (personKey) => (await readHosts(personKey, false)).hosts,
    add(personKey, host) {
      const next = (queues.get(personKey) ?? Promise.resolve()).catch(() => {}).then(() => append(personKey, host));
      queues.set(personKey, next);
      return next;
    },
  };
}
