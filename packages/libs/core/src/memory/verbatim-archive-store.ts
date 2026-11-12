/**
 * The verbatim conversation archive (issue #4): a durable, lossless record
 * of the complete user↔model exchange, one entry per message, distinct from
 * every other memory layer.
 *
 * How it differs from the neighbours in this directory:
 * - Layer-1 history (`../session/history.ts`) is a sliding window that
 *   summarizes itself away — lossy by design.
 * - The episodic store (`./episodic-store.ts`) captures a *summary* of a
 *   closed session — derived, not raw.
 * This archive instead keeps what was actually said, verbatim, so a later
 * session can resurface it and re-read it in light of new facts. It only
 * ever appends and reads; nothing here evicts (retention bounding is a
 * separate, later concern).
 *
 * The messages are kept in the declared conversation store, read back by
 * person and conversation in time order; the search by meaning
 * (`searchVerbatim`) goes through the vector index's `verbatim_archive`
 * space, where each message is indexed under its own id when there's one.
 */
import type { ConversationStore, StoredMessage, VectorIndex } from "@mercury-fw/channel-types";
import type { CallRecord } from "../session/call-record.ts";
import type { TraceEntry } from "../session/turn-trace.ts";

/**
 * The vector index's space the archived messages are searched in: the
 * archive's own collection, whose points already carry their vectors.
 */
export const VERBATIM_SPACE = "verbatim_archive";

/**
 * Makes sure the archive's search space exists with `dimensions`-long vectors
 * and the fields it's filtered (`userId`, `sessionKey`) and ordered
 * (`timestamp`) on. Idempotent, safe on every startup.
 */
export async function ensureVerbatimSpace(index: VectorIndex, dimensions: number): Promise<void> {
  await index.ensure(VERBATIM_SPACE, { dimensions, keys: ["userId", "sessionKey"], ordered: ["timestamp"] });
}

/**
 * A single verbatim message as it was emitted in chat. `timestamp` (ISO 8601,
 * ms precision) is the durable ordering key. `content` is what the model said;
 * `displays` are what the turn showed after it (the lists the model chose to
 * `present`), absent on messages archived before they were kept. `calls` are
 * the tool calls an answer was written from, reduced (`call-record.ts`): they
 * go back to the model with a resumed conversation, never to the person.
 * `interrupted` marks an answer whose turn was stopped before it was
 * finished: its `content` is the text the history kept in its place, for
 * the model, never shown to the person. `trace` is what the person saw of the
 * turn besides its text (`../session/turn-trace.ts`), and `pendingNote` the
 * core's stand-in sentence `content` begins with when the turn only staged an
 * action: both for the person, never for the model. `confirmation` marks the
 * message that says how a staged action was resolved, outside any turn: it
 * never goes back to the model either. `turnId` is the id the turn's trace
 * events carry, absent on messages archived before it was kept and outside a
 * turn.
 */
export type VerbatimMessage = {
  userId: string;
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  displays?: string[];
  calls?: CallRecord[];
  interrupted?: true;
  trace?: TraceEntry[];
  pendingNote?: string;
  confirmation?: ArchivedConfirmation;
  turnId?: string;
  timestamp: string;
};

/**
 * How a staged action was resolved: `id` is the staging's (`confirmationId`),
 * the one its trace entry carries, with what the action was; `choice` the
 * label of the choice taken, when it was one of several.
 */
export type ArchivedConfirmation = {
  id: string;
  status: "ok" | "failed" | "resume";
  choice?: string;
};

/**
 * What the person saw: the model's text followed by the displays, non-empty
 * parts only, a blank line between them. The turn's final text is built the
 * same way.
 */
export function shownText(content: string, displays: string[] | undefined): string {
  return [content, ...(displays ?? [])].filter((part) => part !== "").join("\n\n");
}

/** `m` as the person saw it, for whatever renders a conversation: the displays folded into `content`, no calls, no text for an interrupted answer; its trace, pending note and confirmation as they are. */
function asShown(m: VerbatimMessage): VerbatimMessage {
  const { displays, calls: _calls, ...rest } = m;
  if (m.interrupted) return { ...rest, content: "" };
  return displays === undefined ? rest : { ...rest, content: shownText(m.content, displays) };
}

/**
 * Whether `m` has words of the model's own (or the person's). An answer that was
 * only displays has none, and what goes back to the model leaves it out.
 */
function said(m: VerbatimMessage): boolean {
  return m.content.trim() !== "";
}

/** Whether `m` is something the model said or was told: not how a confirmation was resolved. */
function forModel(m: VerbatimMessage): boolean {
  return m.confirmation === undefined;
}

/** `m` as the model said it, for whatever hands it back to the model: no displays, nothing that was only for the person. */
function asSaid(m: VerbatimMessage): VerbatimMessage {
  const { displays: _displays, trace: _trace, pendingNote: _note, ...rest } = m;
  return rest;
}

/** `m` without its calls: what `recall_verbatim` quotes is what was said. */
function withoutCalls(m: VerbatimMessage): VerbatimMessage {
  const { calls: _calls, ...rest } = m;
  return rest;
}

/** How much of a budget `m` takes back to the model: its text and, as JSON, its calls (as the history counts them). */
function modelChars(m: VerbatimMessage): number {
  return m.content.length + (m.calls === undefined ? 0 : JSON.stringify(m.calls).length);
}

/** Whether `value` looks like a list of `CallRecord`s, as `appendVerbatimMessage` stored them. */
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

/** Whether `value` looks like a trace, as `appendVerbatimMessage` stored it: entries with a known type. */
function isTrace(value: unknown): boolean {
  const types = ["reasoning", "tool", "confirmation", "login"];
  return (
    Array.isArray(value) &&
    value.every((e) => e !== null && typeof e === "object" && types.includes((e as { type?: unknown }).type as string))
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

/** `m` without a trace or a pending note it can't vouch for: the message itself still stands. */
function withValidExtras(m: VerbatimMessage): VerbatimMessage {
  const { trace, pendingNote, ...rest } = m;
  return {
    ...rest,
    ...(trace !== undefined && isTrace(trace) ? { trace } : {}),
    ...(typeof pendingNote === "string" ? { pendingNote } : {}),
  };
}

/** The verbatim messages among `payloads`, skipping malformed ones and dropping malformed extras. */
function verbatimMessages(payloads: Array<Record<string, unknown> | null>): VerbatimMessage[] {
  return payloads.filter(isVerbatimMessage).map(withValidExtras);
}

/** The verbatim messages among what the store gave, without the store's ids. */
function storedMessages(messages: StoredMessage[]): VerbatimMessage[] {
  return verbatimMessages(messages.map(({ id: _id, ...m }) => m));
}

/**
 * Keeps `entry` in the store under a new id and, when `search` is given,
 * indexes it under the same id in the archive's search space, its vector
 * embedded from `entry.content` (what was shown, when the model said nothing;
 * for a resolved confirmation with no reply, its choice or how it went, since
 * nothing searches it: recall leaves it out), its payload the full message.
 */
export async function appendVerbatimMessage(
  store: ConversationStore,
  entry: VerbatimMessage,
  search?: {
    index: VectorIndex;
    embed: (text: string) => Promise<number[]>;
    /** Runs the indexing later, as background work; awaited here when absent. */
    defer?: (work: () => Promise<void>) => void;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  await store.append({ id, ...entry });
  if (search === undefined) return;
  const index = async () => {
    const shown = entry.content.trim() !== "" ? entry.content : shownText(entry.content, entry.displays);
    const vector = await search.embed(shown !== "" ? shown : (entry.confirmation?.choice ?? entry.confirmation?.status ?? ""));
    await search.index.upsert(VERBATIM_SPACE, [{ id, vector, payload: { ...entry } }]);
  };
  if (search.defer === undefined) await index();
  else search.defer(index);
}

const DEFAULT_SEARCH_LIMIT = 5;

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

/**
 * The verbatim messages for a specific user most relevant to `queryText`
 * — e.g. "what did we say about KAN-1 last week". Filtered by `userId` so
 * one user's transcript never leaks into another's. Only reads; returns
 * the messages as the model said them (no displays, and no answer that was
 * only displays: this goes back to the model), ordering left to the caller
 * (each carries its own `timestamp`).
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
  return verbatimMessages(results.map((r) => r.payload)).filter(forModel).filter(said).map(asSaid).map(withoutCalls);
}

/**
 * How many recent messages `listVerbatimSessions` scans to build the
 * conversation list. A store has no DISTINCT, so we dedup here
 * over a bounded window of the newest messages — a conversation whose newest
 * message falls outside this window won't appear. Ample for a live-testing UI
 * sidebar; retention/aggregation is a separate later concern.
 */
const SESSION_SCAN_LIMIT = 500;

/** One conversation in the list view: its key, the timestamp of its most recent message, and a short preview of it. */
export type VerbatimSession = {
  sessionKey: string;
  lastTimestamp: string;
  preview: string;
};

/** Max characters of the most-recent message shown as a conversation's preview. */
const PREVIEW_CHARS = 120;

/**
 * One person's conversations, most-recently-active first — the sidebar a UI
 * shows to switch between them. Scrolls the person's newest `SESSION_SCAN_LIMIT`
 * messages (timestamp desc) and dedups by `sessionKey`, keeping each
 * conversation's most recent message for its timestamp and its most recent
 * one with something shown for its preview (displays included; an
 * interrupted answer shows nothing, so its question is the preview), then
 * caps the result at `limit`.
 */
export async function listVerbatimSessions(
  store: ConversationStore,
  query: { userId: string; limit: number },
): Promise<{ conversations: VerbatimSession[] }> {
  const messages = storedMessages(await store.recent({ userId: query.userId, limit: SESSION_SCAN_LIMIT }));
  const seen = new Map<string, VerbatimSession>();
  // The conversations whose preview is still to come: their newest messages showed nothing (an interrupted answer, a resumed confirmation).
  const previewless = new Set<string>();
  for (const m of messages) {
    // desc order → first occurrence is the most recent
    const known = seen.get(m.sessionKey);
    if (known !== undefined && !previewless.has(m.sessionKey)) {
      continue;
    }
    const shown = m.interrupted ? "" : shownText(m.content, m.displays);
    if (shown === "") previewless.add(m.sessionKey);
    else previewless.delete(m.sessionKey);
    seen.set(m.sessionKey, {
      sessionKey: m.sessionKey,
      lastTimestamp: known?.lastTimestamp ?? m.timestamp,
      preview: shown.length <= PREVIEW_CHARS ? shown : `${shown.slice(0, PREVIEW_CHARS)}…`,
    });
  }
  return { conversations: [...seen.values()].slice(0, query.limit) };
}

/** A page of a conversation's verbatim messages, plus the opaque cursor for the next page (null when exhausted). */
export type VerbatimPage = {
  messages: VerbatimMessage[];
  nextOffset: string | null;
};

/**
 * The verbatim messages of one conversation (`sessionKey`) in chronological
 * order — the durable transcript a UI renders when it (re)loads a conversation.
 * Unlike `searchVerbatim` this is a plain read (no similarity), filtered by
 * the person (`userId`) and the conversation (`sessionKey`), so a session key
 * that isn't the person's own yields nothing, ordered by `timestamp`
 * ascending, paged via the opaque `offset` cursor. Each message comes as the
 * person saw it, its displays folded into `content`.
 */
export async function listVerbatimBySession(
  store: ConversationStore,
  query: { userId: string; sessionKey: string; limit: number; offset?: string },
): Promise<VerbatimPage> {
  const page = await store.messages({
    userId: query.userId,
    sessionKey: query.sessionKey,
    order: "asc",
    limit: query.limit,
    ...(query.offset === undefined ? {} : { cursor: query.offset }),
  });
  return { messages: storedMessages(page.messages).map(asShown), nextOffset: page.next ?? null };
}

/** How many of a conversation's newest messages `listVerbatimTail` reads at most. */
const TAIL_SCAN_LIMIT = 200;

/**
 * The end of a conversation, oldest first, and whether it reaches the
 * conversation's first message. `leftOutAt` is the timestamp of the newest
 * archived message left out of it (absent when complete): what came before
 * the tail, which a summary has to cover.
 */
export type VerbatimTail = {
  messages: Array<{ role: "user" | "assistant"; content: string; calls?: CallRecord[]; timestamp: string }>;
  complete: boolean;
  leftOutAt?: string;
};

/**
 * The newest messages of one conversation (`sessionKey`) of the person
 * `userId` whose content (calls included) fits `maxChars`, in chronological order — what a
 * resumed conversation hands back to the model. Reads at most
 * `TAIL_SCAN_LIMIT` messages, newest first, stops at the first one that
 * doesn't fit, leaves out answers that were only displays (no words to hand
 * back) and how confirmations were resolved (never in the history), and drops leading assistant messages, so the tail always
 * opens with what the person said. `complete` is true only when every
 * message of the conversation made it in.
 */
export async function listVerbatimTail(
  store: ConversationStore,
  query: { userId: string; sessionKey: string; maxChars: number },
): Promise<VerbatimTail> {
  const page = await store.messages({ userId: query.userId, sessionKey: query.sessionKey, order: "desc", limit: TAIL_SCAN_LIMIT });
  const newestFirst = storedMessages(page.messages).filter(forModel).filter(said);
  const taken: VerbatimMessage[] = [];
  let chars = 0;
  for (const m of newestFirst) {
    if (chars + modelChars(m) > query.maxChars) break;
    chars += modelChars(m);
    taken.push(m);
  }
  const chronological = taken.reverse();
  const firstUser = chronological.findIndex((m) => m.role === "user");
  const kept = firstUser === -1 ? [] : chronological.slice(firstUser);
  const messages = kept.map((m) =>
    m.calls === undefined
      ? { role: m.role, content: m.content, timestamp: m.timestamp }
      : { role: m.role, content: m.content, calls: m.calls, timestamp: m.timestamp },
  );
  const complete = page.messages.length < TAIL_SCAN_LIMIT && messages.length === newestFirst.length;
  if (complete) return { messages, complete };
  // Newest first, the first message not kept.
  const leftOut = newestFirst[kept.length];
  return leftOut === undefined ? { messages, complete } : { messages, complete, leftOutAt: leftOut.timestamp };
}
