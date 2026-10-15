/**
 * What Mercury keeps about each person as a setting, not a note: for now the
 * name to call them by, which they tell the assistant in conversation (see
 * `set_preferred_name` in `profile-tools.ts`). Keyed by the person's key, so
 * it follows the person across their conversations, and the owner when
 * accounts are linked.
 *
 * Kept like the account links (`links.ts`): one JSON file on the vault's
 * volume, outside every path the model and the HTTP reads can reach and out
 * of the vault's git, written whole and atomically, reread whenever it changed
 * on disk. An unreadable file gives nobody a name and is never written over.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Where the people's settings live on the vault's volume (`vault-init.ts` keeps `.mercury/` out of its git). */
export function profilesPath(vaultPath: string): string {
  return resolve(vaultPath, ".mercury", "profiles.json");
}

const MAX_NAME_LENGTH = 80;

/** Why `name` (already trimmed) can't be what the assistant calls someone, or undefined when it can. It goes into the prompt, so one line only. */
function nameError(name: string): string | undefined {
  if (name.length === 0) return "the name is empty";
  if (name.length > MAX_NAME_LENGTH) return `the name is longer than ${MAX_NAME_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(name)) return "the name has a line break or another control character";
  return undefined;
}

type Profile = { name: string; updatedAt: string };
type ProfileFile = { version: 1; people: Record<string, Profile> };

export type ProfileStore = {
  /** The name `key` asked to be called by, or undefined when they never said. */
  nameOf: (key: string) => string | undefined;
  /** Saves the name `key` asked to be called by and returns it trimmed; throws on a name that can't stand in a prompt, or an unreadable file. */
  setName: (key: string, name: string) => string;
};

export function createProfileStore(opts: { path: string; now?: () => Date; log?: (msg: string) => void }): ProfileStore {
  const { path } = opts;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((msg: string) => console.error(msg));
  let people = new Map<string, Profile>();
  /** The file's mtime and size when it was last read or written; undefined when there was none. */
  let seen: string | undefined;
  /** Whether the file was there but couldn't be read: then nothing is written over it. */
  let unreadable = false;

  /** The file's mtime and size, or undefined when it doesn't exist. */
  function mtime(): string | undefined {
    try {
      const st = statSync(path);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }

  /** Rereads the file when it changed since it was last seen. */
  function fresh(): void {
    const current = mtime();
    if (current === seen) return;
    seen = current;
    unreadable = false;
    people = new Map();
    if (current === undefined) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProfileFile>;
      for (const [key, profile] of Object.entries(parsed.people ?? {})) {
        const name = (profile as Partial<Profile> | undefined)?.name;
        if (typeof name !== "string" || nameError(name.trim()) !== undefined) {
          log(`[identity] skipped a malformed profile in ${path}: ${key}`);
          continue;
        }
        people.set(key, { name: name.trim(), updatedAt: String((profile as Profile).updatedAt ?? "") });
      }
    } catch (err) {
      log(`[identity] can't read the people's profiles in ${path}, no names used: ${err instanceof SyntaxError ? "not JSON" : String(err)}`);
      people = new Map();
      unreadable = true;
    }
  }

  /** Writes every profile, whole, through a temporary file renamed over the old one. */
  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    const file: ProfileFile = { version: 1, people: Object.fromEntries(people) };
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temporary, path);
    seen = mtime();
  }

  return {
    nameOf: (key) => {
      fresh();
      return people.get(key)?.name;
    },
    setName: (key, name) => {
      const trimmed = name.trim();
      const error = nameError(trimmed);
      if (error !== undefined) throw new Error(error);
      fresh();
      if (unreadable) throw new Error(`the people's profiles in ${path} can't be read: fix or remove the file first`);
      people.set(key, { name: trimmed, updatedAt: now().toISOString() });
      save();
      return trimmed;
    },
  };
}
