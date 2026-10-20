/**
 * What Mercury keeps about each person as a setting, not a note: the name to
 * call them by and the language to talk to them in, which they tell the
 * assistant in conversation (see `set_preferred_name` and
 * `set_preferred_language` in `profile-tools.ts`). Keyed by the person's key, so
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

/** A language tag (`it`, `pt-br`), lowercase; the store checks only its shape, the tool which ones the instance ships. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/** Why `language` (already trimmed and lowercased) isn't a language tag, or undefined when it is. */
function languageError(language: string): string | undefined {
  return LANGUAGE_TAG.test(language) ? undefined : `"${language}" isn't a language tag such as "en" or "pt-br"`;
}

type Profile = { name?: string; language?: string; updatedAt: string };
type ProfileFile = { version: 1; people: Record<string, Profile> };

export type ProfileStore = {
  /** The name `key` asked to be called by, or undefined when they never said. */
  nameOf: (key: string) => string | undefined;
  /** Saves the name `key` asked to be called by and returns it trimmed; throws on a name that can't stand in a prompt, or an unreadable file. */
  setName: (key: string, name: string) => string;
  /** The language `key` asked to be talked to in, or undefined when they never said. */
  languageOf: (key: string) => string | undefined;
  /** Saves the language `key` asked for and returns it as stored (trimmed, lowercase); throws on what isn't a language tag, or an unreadable file. */
  setLanguage: (key: string, language: string) => string;
};

export function createProfileStore(opts: { path: string; now?: () => Date; log?: (msg: string) => void }): ProfileStore {
  const { path } = opts;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((msg: string) => console.error(msg));
  let people = new Map<string, Profile>();
  /** Entries the file holds but that aren't usable, written back as they are for someone to fix. */
  let malformed = new Map<string, unknown>();
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
    malformed = new Map();
    if (current === undefined) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProfileFile>;
      for (const [key, profile] of Object.entries(parsed.people ?? {})) {
        const read = readProfile(profile);
        if (read === undefined) {
          log(`[identity] skipped a malformed profile in ${path}: ${key}`);
          malformed.set(key, profile);
          continue;
        }
        people.set(key, read);
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
    const file = { version: 1, people: { ...Object.fromEntries(malformed), ...Object.fromEntries(people) } };
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temporary, path);
    seen = mtime();
  }

  /** Writes `change` into `key`'s profile, keeping the rest of it; throws on an unreadable file. */
  function update(key: string, change: Partial<Profile>): void {
    fresh();
    if (unreadable) throw new Error(`the people's profiles in ${path} can't be read: fix or remove the file first`);
    malformed.delete(key);
    people.set(key, { ...people.get(key), ...change, updatedAt: now().toISOString() });
    save();
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
      update(key, { name: trimmed });
      return trimmed;
    },
    languageOf: (key) => {
      fresh();
      return people.get(key)?.language;
    },
    setLanguage: (key, language) => {
      const tag = language.trim().toLowerCase();
      const error = languageError(tag);
      if (error !== undefined) throw new Error(error);
      update(key, { language: tag });
      return tag;
    },
  };
}

/** A profile as read from the file, or undefined when it's malformed: a name or a language that isn't valid, or neither. */
function readProfile(raw: unknown): Profile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { name, language, updatedAt } = raw as Record<string, unknown>;
  const profile: Profile = { updatedAt: String(updatedAt ?? "") };
  if (name !== undefined) {
    if (typeof name !== "string" || nameError(name.trim()) !== undefined) return undefined;
    profile.name = name.trim();
  }
  if (language !== undefined) {
    if (typeof language !== "string" || languageError(language) !== undefined) return undefined;
    profile.language = language;
  }
  return profile.name === undefined && profile.language === undefined ? undefined : profile;
}
