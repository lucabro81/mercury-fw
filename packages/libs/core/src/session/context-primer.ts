/**
 * Builds the primer seeded into a brand-new session's conversation (see
 * `conversations.ts`): the person's confirmations still pending, as opaque
 * references, plus their last closed session's own episodic entries. Empty
 * when there's nothing: enrichment, a caller works fine without it.
 * Deliberately not similarity retrieval: there's no query yet to compare
 * against at session start, only "what happened last time" (see
 * `getLastSessionEpisodicSummaries`) and "what is still open".
 */
import type { EpisodicSummary } from "../memory/episodic-store.ts";

export type ContextPrimerDeps = {
  /** Already scoped to the last closed session's own sessionKey — see `getLastSessionEpisodicSummaries`. */
  getLastSessionEntries: (key: string) => Promise<EpisodicSummary[]>;
  /** The tokens of the person's confirmations still pending (see `data/confirmation-notes.ts`). */
  pendingTokens: (key: string) => Promise<string[]>;
  /** Where a skipped section says why (the recap, when the index doesn't answer). */
  log: (msg: string) => void;
};

/**
 * How the primer is built for a turn: no last session on a conversation its
 * client reopens at will (`resume`, the HTTP surface), where a new one is a
 * deliberate fresh start; with it on a single running stream (Google Chat).
 */
export function primerOptions(resume: { maxChars?: number } | undefined): { lastSession: boolean } {
  return { lastSession: resume === undefined };
}

/**
 * A primer in its two parts, each empty when there's nothing: `current` is the
 * state the model uses as is (the confirmations still pending), `recap` the
 * last session, background that may be out of date.
 */
export type ContextPrimer = { current: string; recap: string };

/**
 * Text of the primer for the person `key`, built from injected deps only — never
 * touches the index or the filesystem directly, so tests supply fakes and
 * `compose.ts` supplies the real episodic query and the notes.
 *
 * `lastSession: false` leaves out the last session's recap: on a channel where the person opens and reopens conversations at
 * will, a new one is a fresh start, and nothing from another conversation comes
 * in unless they ask for it.
 */
export async function buildContextPrimer(
  key: string,
  deps: ContextPrimerDeps,
  opts: { lastSession?: boolean } = {},
): Promise<ContextPrimer> {
  // Episodic memory is enrichment: without Qdrant the primer goes on without
  // the recap instead of failing the turn.
  const entries =
    opts.lastSession === false
      ? []
      : await deps.getLastSessionEntries(key).catch((err: unknown) => {
          deps.log(`last session for ${key} unavailable, primer built without it: ${String(err)}`);
          return [];
        });
  // Checked regardless of `entries` — a pending confirmation isn't tied to
  // "was there a prior episodic session", it's simply still open right now.
  const pendingTokens = await deps.pendingTokens(key);
  const current: string[] = [];
  const recap: string[] = [];

  if (entries.length > 0) {
    recap.push(`Last session:\n${entries.map((e) => `- ${e.summary}`).join("\n")}`);
  }

  // Deliberately opaque: just the token, no command, no "still pending"
  // narrative. Resolving it into something meaningful requires the model to
  // deliberately call resolve_reference (tools/resolve-reference-tool.ts).
  if (pendingTokens.length > 0) {
    current.push(`Open references:\n${pendingTokens.map((t) => `- [REQ:${t}]`).join("\n")}`);
  }

  return { current: current.join("\n\n"), recap: recap.join("\n\n") };
}
