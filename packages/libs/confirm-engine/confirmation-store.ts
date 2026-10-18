/**
 * In-memory staging area for an irreversible action that needs explicit
 * confirmation before it runs. Something stages it here, and the channel gets
 * the returned token confirmed back to it — a card button click on Google Chat,
 * a bare token typed on the terminal — before anything actually happens (see
 * `confirm-flow.ts`). Scoped by `sessionKey` and by the person who staged it
 * (`owner`, the core's user key), so a token proposed in one session can't be
 * confirmed from another, nor by someone else in the same one.
 *
 * The action is opaque: a `run` thunk that performs it and a `describe` string
 * for the paper trail. The store — and the whole confirmation subsystem — knows
 * nothing about what kind of action it is: whoever stages it closes over the
 * doing, and the core just runs the thunk when the token comes back. */
import type { ActionResult, ResumeAs } from "@mercury-fw/plugin-types";
/**
 * `label` names the choice when the action is one of a group (see
 * `stageGroup`); `resume` asks for the model's turn to resume with the
 * action's result once it runs (see `ConfirmDeps.onResume`); `noteToken` is set
 * by `take`: the token the paper-trail note of the action is kept under, the
 * group's first token, or the action's own when it was staged alone.
 */
export type StagedAction = {
  run: () => Promise<ActionResult>;
  describe: string;
  requestedAt?: string;
  label?: string;
  resume?: ResumeAs;
  noteToken?: string;
};

/** A pending staging as seen from outside, deliberately WITHOUT its token or
 * its executable thunk: a token is a confirm capability, so listing pending
 * confirmations must never hand out the tokens (or a way to run the action),
 * only the human-readable `summary` (the action's `describe`). */
export type PendingConfirmation = { sessionKey: string; summary: string; expiresAt: number };

export type ConfirmationStore = {
  /** Stages `action` for `owner` in `sessionKey` and returns a fresh token. */
  stage(sessionKey: string, owner: string, action: StagedAction): string;
  /** Stages `actions` as the choices of one group, sharing one expiry, and
   * returns a fresh token for each, in order. Taking any of them removes the
   * whole group: the person picks one choice, never two. */
  stageGroup(sessionKey: string, owner: string, actions: StagedAction[]): string[];
  /** Consumes and returns the staged action for `sessionKey`/`owner`/`token`, or
   * `null` if it doesn't exist, belongs to a different session or person, or has
   * expired. Always one-shot: a successful take removes the entry, a refused one
   * leaves it for its owner. */
  take(sessionKey: string, owner: string, token: string): StagedAction | null;
  /** `owner`'s staged, non-expired actions, redacted of their tokens, for
   * read-only introspection (see `PendingConfirmation`). */
  pending(owner: string): PendingConfirmation[];
};

// Full alphanumeric — a token is only ever copy-pasted, never read or
// typed from memory, so legibility (avoiding 0/O/1/l/I) was never the
// actual point. What makes a token distinguishable from ordinary text is
// its shape below (two groups joined by a fixed hyphen), not a restricted
// character set — a restricted set doesn't help anyway: it still collides
// with any real short word that happens to avoid the same few excluded
// characters (found live: "second", used as plain conversational text,
// was indistinguishable from a real token under the old bare-6-char shape).
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_GROUP_LENGTH = 4;
const DEFAULT_TTL_MS = 5 * 60_000;

function randomGroup(): string {
  const bytes = new Uint8Array(TOKEN_GROUP_LENGTH);
  crypto.getRandomValues(bytes);
  let group = "";
  for (const b of bytes) {
    group += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  }
  return group;
}

/** `<4 alphanumeric>-<4 alphanumeric>`, e.g. `k9m2-x7q4` — see `TOKEN_ALPHABET`'s own doc comment for why this shape, not a restricted character set, is what makes a token distinguishable from ordinary text. */
function defaultTokenFn(): string {
  return `${randomGroup()}-${randomGroup()}`;
}

/** `group` is every token staged together with this one, this one included, in staging order. */
type Entry = { action: StagedAction; sessionKey: string; owner: string; expiresAt: number; group: string[] };

export function createConfirmationStore(
  opts: { now?: () => number; ttlMs?: number; tokenFn?: () => string } = {},
): ConfirmationStore {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const tokenFn = opts.tokenFn ?? defaultTokenFn;
  const entries = new Map<string, Entry>();

  /** Stages `actions` under fresh tokens that know one another, all expiring together. */
  function stageAll(sessionKey: string, owner: string, actions: StagedAction[]): string[] {
    const group = actions.map(() => tokenFn());
    const expiresAt = now() + ttlMs;
    actions.forEach((action, i) => entries.set(group[i]!, { sessionKey, owner, action, expiresAt, group }));
    return group;
  }

  return {
    stage(sessionKey, owner, action) {
      return stageAll(sessionKey, owner, [action])[0]!;
    },
    stageGroup(sessionKey, owner, actions) {
      return stageAll(sessionKey, owner, actions);
    },
    take(sessionKey, owner, token) {
      const entry = entries.get(token);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt <= now()) {
        for (const t of entry.group) entries.delete(t);
        return null;
      }
      if (entry.sessionKey !== sessionKey || entry.owner !== owner) {
        return null;
      }
      for (const t of entry.group) entries.delete(t);
      return { ...entry.action, noteToken: entry.group[0]! };
    },
    pending(owner) {
      const t = now();
      const out: PendingConfirmation[] = [];
      for (const [token, entry] of entries) {
        // A group is listed once, by its first token's entry.
        if (entry.expiresAt <= t || entry.owner !== owner || token !== entry.group[0]) continue;
        out.push({
          sessionKey: entry.sessionKey,
          summary: entry.action.describe,
          expiresAt: entry.expiresAt,
        });
      }
      return out;
    },
  };
}

const TOKEN_SHAPE_RE = new RegExp(`^[${TOKEN_ALPHABET}]{${TOKEN_GROUP_LENGTH}}-[${TOKEN_ALPHABET}]{${TOKEN_GROUP_LENGTH}}$`);

/**
 * True if `input` (trimmed) has the exact shape of a token this store
 * mints — same alphabet, same length. Not a security boundary itself
 * (that's `take()`'s existence/session/expiry check) — just enough to
 * tell apart "this looks like a confirmation attempt" from "this is an
 * ordinary message", so a caller (`tryConfirm` in `confirm-flow.ts`) knows
 * whether to intercept at all before ever touching the store.
 */
export function isTokenShaped(input: string): boolean {
  return TOKEN_SHAPE_RE.test(input.trim());
}
