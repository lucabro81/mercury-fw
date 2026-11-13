/**
 * The end of a conversation as the archive kept it (the conversation store,
 * `ctx.conversations`), read back for the model when its client reopens it:
 * what the person and the model said, never what was only for the person
 * (the lists they were shown, the trace, how a confirmation was resolved).
 *
 * The archive holds whatever its writers wrote over time, so a message that
 * isn't one is skipped, and calls that aren't calls are left off their answer.
 */
import type { CallRecord, ConversationStore, StoredMessage } from "@mercury-fw/plugin-types";

/** How many of a conversation's newest messages `readTail` reads at most. */
const TAIL_SCAN_LIMIT = 200;

/** A message of the tail: who spoke, what they said, the calls of an answer, when it was archived. */
export type TailMessage = { role: "user" | "assistant"; content: string; calls?: CallRecord[]; timestamp: string };

/**
 * The end of a conversation, oldest first, and whether it reaches the
 * conversation's first message. `leftOutAt` is the timestamp of the newest
 * archived message left out of it (absent when complete): what came before
 * the tail, which a summary has to cover.
 */
export type Tail = { messages: TailMessage[]; complete: boolean; leftOutAt?: string };

/** Whether `value` looks like a list of calls, as the archive's writers keep them. */
function isCallList(value: unknown): value is CallRecord[] {
  return (
    Array.isArray(value) &&
    value.every((c) => c !== null && typeof c === "object" && typeof (c as { toolName?: unknown }).toolName === "string" && typeof (c as { result?: unknown }).result === "object")
  );
}

/** `m` as the model said it or was told it, or undefined when it isn't one: malformed, how a confirmation was resolved, an answer with no words. */
function forModel(m: StoredMessage): TailMessage | undefined {
  const raw = m as Partial<Record<keyof StoredMessage, unknown>>;
  if (raw.role !== "user" && raw.role !== "assistant") return undefined;
  if (typeof raw.content !== "string" || typeof raw.timestamp !== "string") return undefined;
  if (raw.confirmation !== undefined) return undefined;
  if (raw.content.trim() === "") return undefined;
  const base: TailMessage = { role: raw.role, content: raw.content, timestamp: raw.timestamp };
  return isCallList(raw.calls) ? { ...base, calls: raw.calls } : base;
}

/** How much of the budget `m` takes: its text and, as JSON, its calls. */
export function tailChars(m: Pick<TailMessage, "content" | "calls">): number {
  return m.content.length + (m.calls === undefined ? 0 : JSON.stringify(m.calls).length);
}

/**
 * The newest messages of the conversation `sessionKey` of the person `userId`
 * that fit `maxChars`, oldest first. Reads at most `TAIL_SCAN_LIMIT`
 * messages, newest first, stops at the first one that doesn't fit, and drops
 * leading answers, so the tail always opens with what the person said.
 * `complete` is true only when every message of the conversation made it in.
 */
export async function readTail(store: ConversationStore, query: { userId: string; sessionKey: string; maxChars: number }): Promise<Tail> {
  const page = await store.messages({ userId: query.userId, sessionKey: query.sessionKey, order: "desc", limit: TAIL_SCAN_LIMIT });
  const newestFirst = page.messages.map(forModel).filter((m): m is TailMessage => m !== undefined);
  const taken: TailMessage[] = [];
  let chars = 0;
  for (const m of newestFirst) {
    if (chars + tailChars(m) > query.maxChars) break;
    chars += tailChars(m);
    taken.push(m);
  }
  const chronological = taken.reverse();
  const firstUser = chronological.findIndex((m) => m.role === "user");
  const messages = firstUser === -1 ? [] : chronological.slice(firstUser);
  const complete = page.messages.length < TAIL_SCAN_LIMIT && messages.length === newestFirst.length;
  if (complete) return { messages, complete };
  // Newest first, the first message not kept.
  const leftOut = newestFirst[messages.length];
  return leftOut === undefined ? { messages, complete } : { messages, complete, leftOutAt: leftOut.timestamp };
}
