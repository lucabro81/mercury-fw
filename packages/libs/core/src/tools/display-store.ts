/**
 * In-memory staging area for the user-facing `display` artifacts a tool
 * produces (see `ToolDisplay` and the formatter decorator), decoupling
 * *producing* an artifact from *showing* it. A tool `stash`es its already-
 * rendered artifact here and gets back a short `ref`; the model, and only
 * the model, decides whether to actually surface it by calling the
 * `present` tool (see `present-tool.ts`), which marks the ref via
 * `surface`. At finalize the turn runner appends only what
 * `takeSurfaced` returns — the artifacts the model explicitly asked to
 * show — never the whole set unconditionally. The worst case becomes
 * omission (the user says "show me"), never a garbled or force-appended
 * list.
 *
 * Scoped by `sessionKey`, exactly like `confirmation-store.ts`: a ref
 * minted for one session (terminal, or a given Google Chat space+sender)
 * can't be surfaced by another. The store is created once and shared
 * across turns, so a ref stays valid for a later "show me that list again"
 * follow-up — session-scoped, not turn-scoped. An entry lives as long as its
 * conversation: `forget` drops it when the session is closed, at most the 10
 * most recent are kept per session, and a day-long TTL reclaims what no
 * sweep ever closes. Each entry keeps a short label (the command that built
 * it), so `shown` can tell the model which lists it has already shown: the
 * history never keeps the lists.
 */
export type DisplayStore = {
  /** Stashes `artifact` for `sessionKey`, with what it is (`label`), and returns a fresh ref. */
  stash(sessionKey: string, artifact: string, label?: string): string;
  /** Marks `ref` to be shown at finalize. Returns `false` if it doesn't
   * exist, belongs to a different session, or has expired. */
  surface(sessionKey: string, ref: string): boolean;
  /** The artifacts surfaced for `sessionKey`, in stash order. Consumes the
   * surfaced flag (so the same artifact isn't re-appended on a later turn
   * unless `surface` is called again) but keeps the entry until its TTL,
   * so a still-valid ref can be surfaced again across turns. */
  takeSurfaced(sessionKey: string): string[];
  /** The lists shown in `sessionKey` and still valid, most recently shown last. */
  shown(sessionKey: string): Array<{ ref: string; label: string }>;
  /** Drops everything `sessionKey` stashed: its conversation is closed. */
  forget(sessionKey: string): void;
};

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
/** How many entries a conversation keeps: the oldest never shown goes first, then the oldest. */
const MAX_PER_SESSION = 10;
/** A label goes into every prompt: one line, this long at most. */
const MAX_LABEL_LENGTH = 200;

/** `label` on one line, whitespace collapsed, cut at {@link MAX_LABEL_LENGTH}. */
function oneLine(label: string): string {
  const flat = label.replace(/[\s\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").trim();
  return flat.length > MAX_LABEL_LENGTH ? `${flat.slice(0, MAX_LABEL_LENGTH - 1)}…` : flat;
}

type Entry = {
  sessionKey: string;
  artifact: string;
  label: string;
  surfaced: boolean;
  /** When it was last surfaced; undefined when it never was. */
  shownAt: number | undefined;
  expiresAt: number;
};

export function createDisplayStore(
  opts: { now?: () => number; ttlMs?: number; refFn?: () => string } = {},
): DisplayStore {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  let counter = 0;
  const refFn = opts.refFn ?? (() => `d${++counter}`);
  // Insertion-ordered (Map preserves it) so takeSurfaced returns artifacts
  // in stash order regardless of the order the model surfaced them in.
  const entries = new Map<string, Entry>();

  return {
    stash(sessionKey, artifact, label = "") {
      const ref = refFn();
      entries.set(ref, {
        sessionKey,
        artifact,
        label: oneLine(label),
        surfaced: false,
        shownAt: undefined,
        expiresAt: now() + ttlMs,
      });
      // The one just stashed stays; among the rest, a search the model only
      // looked at goes before a list the person saw.
      const own = [...entries].filter(([key, entry]) => entry.sessionKey === sessionKey && key !== ref);
      const order = [...own.filter(([, e]) => e.shownAt === undefined), ...own.filter(([, e]) => e.shownAt !== undefined)];
      for (const [old] of order.slice(0, Math.max(0, own.length + 1 - MAX_PER_SESSION))) entries.delete(old);
      return ref;
    },
    surface(sessionKey, ref) {
      const entry = entries.get(ref);
      if (!entry) {
        return false;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(ref);
        return false;
      }
      if (entry.sessionKey !== sessionKey) {
        return false;
      }
      entry.surfaced = true;
      entry.shownAt = now();
      return true;
    },
    takeSurfaced(sessionKey) {
      const t = now();
      const out: string[] = [];
      // This finalize-time sweep is also where expired entries are reclaimed:
      // the store is a process-lifetime singleton shared across sessions, so
      // without deleting them here an un-surfaced (or never re-surfaced) stash
      // would live forever. Deleting during Map iteration is safe.
      for (const [ref, entry] of entries) {
        if (entry.expiresAt <= t) {
          entries.delete(ref);
          continue;
        }
        if (entry.sessionKey !== sessionKey) continue;
        if (!entry.surfaced) continue;
        out.push(entry.artifact);
        entry.surfaced = false;
      }
      return out;
    },
    shown(sessionKey) {
      const t = now();
      return [...entries]
        .filter(([, entry]) => entry.sessionKey === sessionKey && entry.shownAt !== undefined && entry.expiresAt > t)
        .sort(([, a], [, b]) => a.shownAt! - b.shownAt!)
        .map(([ref, entry]) => ({ ref, label: entry.label }));
    },
    forget(sessionKey) {
      for (const [ref, entry] of entries) if (entry.sessionKey === sessionKey) entries.delete(ref);
    },
  };
}
