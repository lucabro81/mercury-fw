/**
 * The search of what was said (issue #4): every message a turn leaves
 * (`archivedMessages`, the same ones the archive keeps) indexed in the vector
 * index's `verbatim_archive` space, under an id of its own, its payload the
 * whole message; `searchVerbatim` finds the person's messages by meaning, as
 * the model said them (`recall_verbatim`).
 */
import type { StoredMessage, VectorIndex } from "@mercury-fw/plugin-types";

/** The vector index's space the archived messages are searched in. */
export const VERBATIM_SPACE = "verbatim_archive";

/** A message as it's indexed: the archive's shape, without the store's id. */
export type VerbatimMessage = Omit<StoredMessage, "id">;

/**
 * Makes sure the space exists with `dimensions`-long vectors and the fields
 * it's filtered (`userId`, `sessionKey`) and ordered (`timestamp`) on.
 * Idempotent.
 */
export async function ensureVerbatimSpace(index: VectorIndex, dimensions: number): Promise<void> {
  await index.ensure(VERBATIM_SPACE, { dimensions, keys: ["userId", "sessionKey"], ordered: ["timestamp"] });
}

/** What the person saw: the model's text followed by the displays, non-empty parts only, a blank line between them. */
function shownText(content: string, displays: string[] | undefined): string {
  return [content, ...(displays ?? [])].filter((part) => part !== "").join("\n\n");
}

/**
 * Indexes `entry` under a new id, its vector embedded from `entry.content`
 * (what was shown, when the model said nothing; for a resolved confirmation
 * with no reply, its choice or how it went, since nothing searches it:
 * recall leaves it out), its payload the full message.
 */
export async function indexVerbatimMessage(
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  entry: VerbatimMessage,
): Promise<void> {
  const shown = entry.content.trim() !== "" ? entry.content : shownText(entry.content, entry.displays);
  const vector = await embed(shown !== "" ? shown : (entry.confirmation?.choice ?? entry.confirmation?.status ?? ""));
  await index.upsert(VERBATIM_SPACE, [{ id: crypto.randomUUID(), vector, payload: { ...entry } }]);
}

/** Whether `value` looks like a list of `CallRecord`s, as the archive keeps them. */
function isCallList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        typeof (c as { toolName?: unknown }).toolName === "string" &&
        typeof (c as { result?: { ok?: unknown } }).result?.ok === "boolean",
    )
  );
}

/** Whether `value` looks like an `ArchivedConfirmation`. */
function isArchivedConfirmation(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    (c.status === "ok" || c.status === "failed" || c.status === "resume") &&
    (c.choice === undefined || typeof c.choice === "string")
  );
}

/** Narrows an arbitrary payload to a `VerbatimMessage`, rejecting null/malformed points (e.g. from an older schema). */
function isVerbatimMessage(payload: Record<string, unknown> | null): payload is VerbatimMessage {
  return (
    payload !== null &&
    typeof payload.userId === "string" &&
    typeof payload.sessionKey === "string" &&
    (payload.role === "user" || payload.role === "assistant") &&
    typeof payload.content === "string" &&
    (payload.displays === undefined ||
      (Array.isArray(payload.displays) && payload.displays.every((d) => typeof d === "string"))) &&
    (payload.calls === undefined || isCallList(payload.calls)) &&
    (payload.interrupted === undefined || payload.interrupted === true) &&
    (payload.confirmation === undefined || isArchivedConfirmation(payload.confirmation)) &&
    typeof payload.timestamp === "string"
  );
}

/** `m` as the model said it: no displays, nothing that was only for the person, no calls. */
function asSaid(m: VerbatimMessage): VerbatimMessage {
  const { displays: _displays, trace: _trace, pendingNote: _note, calls: _calls, ...rest } = m;
  return rest;
}

const DEFAULT_SEARCH_LIMIT = 5;

/**
 * The person's indexed messages most relevant to `queryText` ("what did we
 * say about KAN-1 last week"), filtered by `userId` so one person's messages
 * never reach another. Returns them as the model said them: no displays, no
 * answer that was only displays, no resolved confirmation, no calls; ordering
 * left to the caller (each carries its own `timestamp`).
 */
export async function searchVerbatim(
  index: VectorIndex,
  embed: (text: string) => Promise<number[]>,
  query: { userId: string; queryText: string; limit?: number },
): Promise<VerbatimMessage[]> {
  const vector = await embed(query.queryText);
  const results = await index.query(VERBATIM_SPACE, {
    vector,
    where: { userId: query.userId },
    limit: query.limit ?? DEFAULT_SEARCH_LIMIT,
  });
  return results
    .map((r) => r.payload)
    .filter(isVerbatimMessage)
    .filter((m) => m.confirmation === undefined && m.content.trim() !== "")
    .map(asSaid);
}
