/**
 * One session's files: what the strategy moved out of the model's context
 * (tool outputs, older messages, session layers), kept in the plugin's data
 * folder, one folder per session, and read back in pieces by the model.
 *
 * A session's folder is named by a hash of its key, so no key reaches outside
 * `<dataDir>/sessions/`; a ref (`outputs/3`, `history/1`, `layers/2`) is
 * always relative to it, and anything not of that shape is refused. Each
 * file is written atomically (a temporary file, then a rename), and so is the
 * folder's `index.json`, which lists the files with their labels: a session
 * finds its files again after a restart, or when its conversation is reopened
 * after the session closed. The index's time is the folder's last use, renewed
 * by every write and every opening; `removeStaleSessions` removes the folders
 * unused for too long.
 *
 * Used by: `conversation.ts` (writing), `tools.ts` (reading and searching).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What a session keeps in files. */
export type FileKind = "outputs" | "history" | "layers";

/** A file of the session as its index lists it. */
export type FileEntry = { ref: string; label: string; lines: number; chars: number };

/** How many lines a read gives at most. */
export const MAX_READ_LINES = 200;
/** How many matches a search gives at most. */
export const MAX_MATCHES = 50;
/** How many characters of a matching line a search shows. */
const MAX_MATCH_CHARS = 200;

const REF = /^(outputs|history|layers)\/([1-9][0-9]*)$/;

export type ReadResult =
  | { ok: true; ref: string; from: number; to: number; totalLines: number; text: string; next?: number }
  | { ok: false; error: string };

export type SearchResult = { ok: true; matches: string[]; truncated: boolean } | { ok: false; error: string };

/** One session's files; see the module comment. */
export type SessionFiles = {
  /** Writes `text` as a new file of `kind`, listed with `label` and found again by `key` (see `refFor`); resolves to its ref. */
  write: (kind: FileKind, text: string, label: string, key?: string) => Promise<string>;
  /** The session's files, in the order written. */
  entries: () => FileEntry[];
  /** The newest file written with `key`, if any. */
  refFor: (key: string) => string | undefined;
  /** Lines `from`–`to` of the file `ref` (1-based, inclusive), numbered, at most `MAX_READ_LINES`. */
  read: (ref: string, from?: number, to?: number) => Promise<ReadResult>;
  /** The lines holding `text` (case-insensitive), in every file or in `ref`, as `ref:line: text`, at most `MAX_MATCHES`. */
  search: (text: string, ref?: string) => Promise<SearchResult>;
};

/** The folder of the session `sessionKey` under `root`. */
export function sessionFolder(root: string, sessionKey: string): string {
  return join(root, "sessions", createHash("sha256").update(sessionKey).digest("hex").slice(0, 32));
}

/** Writes `text` to `path` through a temporary file and a rename. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/** How many lines `text` has. */
function lineCount(text: string): number {
  return text.split("\n").length;
}

/** The refused-ref error. */
function notARef(ref: string): string {
  return `"${ref}" isn't a file of this conversation: refs look like outputs/3, history/1 or layers/2`;
}

/** Reads the index at `path`; empty when missing or unreadable. */
async function readIndex(path: string): Promise<FileEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as FileEntry[]).filter((e) => typeof e?.ref === "string" && REF.test(e.ref)) : [];
  } catch {
    return [];
  }
}

/** Opens the files of the session `sessionKey` under `root`, those already written included. */
export async function openSessionFiles(root: string, sessionKey: string): Promise<SessionFiles> {
  const folder = sessionFolder(root, sessionKey);
  const indexPath = join(folder, "index.json");
  const stored = await readIndex(indexPath);
  // Opening the session is using it: its folder isn't removed as unused.
  const now = new Date();
  await utimes(indexPath, now, now).catch(() => {});
  // What the index keeps besides the entries: the key each file was written for.
  const entries: Array<FileEntry & { key?: string }> = stored;

  /** The text of `ref`, or why there is none. */
  async function textOf(ref: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const match = REF.exec(ref);
    if (match === null) return { ok: false, error: notARef(ref) };
    try {
      return { ok: true, text: await readFile(join(folder, match[1]!, `${match[2]}.txt`), "utf8") };
    } catch {
      return { ok: false, error: `${ref} is no longer available` };
    }
  }

  // Writes go one at a time: each takes the number after the last one written.
  let writing: Promise<unknown> = Promise.resolve();

  /** Writes `text` as the next file of `kind`; see `SessionFiles.write`. */
  async function writeNext(kind: FileKind, text: string, label: string, key?: string): Promise<string> {
    const n = 1 + entries.filter((e) => e.ref.startsWith(`${kind}/`)).reduce((max, e) => Math.max(max, Number(e.ref.slice(kind.length + 1))), 0);
    const ref = `${kind}/${n}`;
    await mkdir(join(folder, kind), { recursive: true });
    await writeAtomic(join(folder, kind, `${n}.txt`), text);
    entries.push({ ref, label, lines: lineCount(text), chars: text.length, ...(key === undefined ? {} : { key }) });
    await writeAtomic(indexPath, JSON.stringify(entries));
    return ref;
  }

  return {
    write: (kind, text, label, key) => {
      const next = writing.then(() => writeNext(kind, text, label, key));
      writing = next.catch(() => {});
      return next;
    },
    entries: () => entries.map(({ key: _key, ...e }) => e),
    refFor: (key) => entries.findLast((e) => e.key === key)?.ref,
    read: async (ref, from = 1, to) => {
      const got = await textOf(ref);
      if (!got.ok) return got;
      const lines = got.text.split("\n");
      const start = Math.max(1, Math.floor(from));
      if (start > lines.length) return { ok: false, error: `${ref} has ${lines.length} lines: from must be ${lines.length} or less` };
      if (to !== undefined && Math.floor(to) < start) return { ok: false, error: `${ref}: to (${Math.floor(to)}) comes before from (${start})` };
      const end = Math.min(lines.length, to === undefined ? lines.length : Math.floor(to), start + MAX_READ_LINES - 1);
      const text = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n");
      const capped = end < lines.length && (to === undefined || end < to);
      return { ok: true, ref, from: start, to: end, totalLines: lines.length, text, ...(capped ? { next: end + 1 } : {}) };
    },
    search: async (text, ref) => {
      const refs = ref === undefined ? entries.map((e) => e.ref) : [ref];
      const needle = text.toLowerCase();
      const matches: string[] = [];
      let truncated = false;
      for (const r of refs) {
        const got = await textOf(r);
        if (!got.ok) {
          if (ref !== undefined) return got;
          continue;
        }
        const lines = got.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.toLowerCase().includes(needle)) continue;
          if (matches.length === MAX_MATCHES) {
            truncated = true;
            break;
          }
          matches.push(`${r}:${i + 1}: ${lines[i]!.slice(0, MAX_MATCH_CHARS)}`);
        }
        if (truncated) break;
      }
      return { ok: true, matches, truncated };
    },
  };
}

/**
 * Removes the folders under `root` of the sessions whose last use is older
 * than `olderThanMs` before `now`, but those of the sessions in `keep` (open
 * ones); resolves to how many it removed.
 */
export async function removeStaleSessions(root: string, q: { olderThanMs: number; now: number; keep: Set<string> }): Promise<number> {
  const sessions = join(root, "sessions");
  const kept = new Set([...q.keep].map((key) => sessionFolder(root, key)));
  let names: string[];
  try {
    names = await readdir(sessions);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const folder = join(sessions, name);
    if (kept.has(folder)) continue;
    try {
      const used = await stat(join(folder, "index.json")).catch(() => stat(folder));
      if (q.now - used.mtimeMs <= q.olderThanMs) continue;
      await rm(folder, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Gone meanwhile, or unreadable: the next run looks again; the others go on.
    }
  }
  return removed;
}
