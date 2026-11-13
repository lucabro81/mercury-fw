/**
 * Builds the primer seeded into a brand-new session's conversation (see
 * `conversations.ts`): the person's confirmations still pending, as opaque
 * references. Empty when there's nothing: a caller works fine without it.
 * What the person's earlier conversations left is the memory plugin's, a
 * context layer of its own.
 */

export type ContextPrimerDeps = {
  /** The tokens of the person's confirmations still pending (see `data/confirmation-notes.ts`). */
  pendingTokens: (key: string) => Promise<string[]>;
};

/** A primer: `current` is the state the model uses as is (the confirmations still pending), empty when there's nothing. */
export type ContextPrimer = { current: string };

/** The primer for the person `key`, built from injected deps only. */
export async function buildContextPrimer(key: string, deps: ContextPrimerDeps): Promise<ContextPrimer> {
  const pendingTokens = await deps.pendingTokens(key);
  // Deliberately opaque: just the token, no command, no "still pending"
  // narrative. Resolving it into something meaningful requires the model to
  // deliberately call resolve_reference (tools/resolve-reference-tool.ts).
  return { current: pendingTokens.length === 0 ? "" : `Open references:\n${pendingTokens.map((t) => `- [REQ:${t}]`).join("\n")}` };
}
