/**
 * One session's window: the raw messages the model reads on every call, kept
 * under a size. When adding a message takes them past `maxChars`, the window
 * shortens what came before the current turn, either folding it into a summary
 * (`summarize`, a model call while the person waits) or dropping the oldest
 * messages (`truncate`), and tells how in a `CompressionReport`.
 *
 * The current turn (from the person's last message on) is never shortened
 * away: a model call always follows the person's message, and a window
 * holding only answers would hand the model a conversation with no question.
 *
 * Used by: `index.ts`, which opens one per session.
 */
import type { CallRecord, CompressionReport, Conversation, ConversationMessage } from "@mercury-fw/plugin-types";

/** A message of the conversation, as the model reads it. */
export type Message = ConversationMessage;

/** How many characters the window holds by default before it shortens what came before. */
export const DEFAULT_MAX_CHARS = 60_000;

/** What a window does when it grows past its size: fold the older messages into a summary, or drop them. */
export type Overflow = "summarize" | "truncate";

/** What a reopened conversation brings back: the summary of its older part, if any, and its newest messages. */
export type ResumedConversation = { summary?: string; messages: Message[] };

export type WindowOptions = {
  /** Folds `messages` into a summary (`summarize` overflow only); may reject. */
  summarize: (messages: Message[]) => Promise<string>;
  /** How many characters of messages the window holds before it shortens; `DEFAULT_MAX_CHARS` when absent. */
  maxChars?: number;
  overflow?: Overflow;
  /** What a reopening brought back: its summary leads the window and its messages open it. Already in memory, so never capturable. */
  resumed?: ResumedConversation;
  /** The clock a report's duration is measured on. */
  now?: () => number;
};

/** A window: the contract's `Conversation`, its capturable part always there. */
export type Window = Conversation & { getCapturable: () => Message[] };

/** How much of the window `m` takes: its text, its context and, as JSON, its calls. */
export function messageChars(m: Message): number {
  return m.content.length + (m.context?.length ?? 0) + (m.calls === undefined ? 0 : JSON.stringify(m.calls).length);
}

/** Wraps a summary as the message that leads the window. */
function summaryMessage(summary: string): Message {
  return { role: "assistant", content: `Earlier conversation summary: ${summary}` };
}

/**
 * Creates a window; see the module comment. A summary that fails leaves the
 * window as it was, past its size, and the next message tries again: the
 * person's turn goes on, its report says the compression failed.
 */
export function createWindow(opts: WindowOptions): Window {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overflow = opts.overflow ?? "summarize";
  const now = opts.now ?? Date.now;
  let rawMessages: Message[] = [...(opts.resumed?.messages ?? [])];
  let summary: string | null = opts.resumed?.summary || null;
  // How much of the window's head came back with `resumed`, until a
  // compression folds it into a new summary or drops it.
  let restoredCount = rawMessages.length;
  let summaryRestored = summary !== null;

  /** Folds what precedes the current turn into a new summary. */
  async function summarizeBefore(lastUserIdx: number): Promise<CompressionReport | void> {
    const toCompress = rawMessages.slice(0, lastUserIdx);
    if (toCompress.length === 0) return;
    const batch = summary ? [summaryMessage(summary), ...toCompress] : toCompress;
    const startedAt = now();
    const charsBefore = batch.reduce((sum, m) => sum + m.content.length, 0);
    try {
      summary = await opts.summarize(batch);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { messages: batch.length, charsBefore, durationMs: now() - startedAt, outcome: "failed", error };
    }
    rawMessages = rawMessages.slice(lastUserIdx);
    restoredCount = Math.max(0, restoredCount - toCompress.length);
    summaryRestored = false;
    return { messages: batch.length, charsBefore, charsAfter: summary.length, durationMs: now() - startedAt, outcome: "done" };
  }

  /** Drops the oldest messages before the current turn until the window fits, keeping it opening with what the person said. */
  function truncateBefore(lastUserIdx: number, total: number): CompressionReport | void {
    let drop = 0;
    let left = total;
    while (drop < lastUserIdx && left > maxChars) {
      left -= messageChars(rawMessages[drop]!);
      drop += 1;
    }
    while (drop < lastUserIdx && rawMessages[drop]!.role !== "user") drop += 1;
    if (drop === 0) return;
    const dropped = rawMessages.slice(0, drop);
    rawMessages = rawMessages.slice(drop);
    restoredCount = Math.max(0, restoredCount - drop);
    return {
      messages: dropped.length,
      charsBefore: dropped.reduce((sum, m) => sum + m.content.length, 0),
      charsAfter: 0,
      durationMs: 0,
      outcome: "done",
    };
  }

  async function add(message: Message): Promise<CompressionReport | void> {
    rawMessages.push(message);
    const total = rawMessages.reduce((sum, m) => sum + messageChars(m), 0);
    if (total <= maxChars) return;
    // A lone message with nothing before it stays live: its question can't be shortened away.
    const lastUserIdx = rawMessages.findLastIndex((m) => m.role === "user");
    const before = lastUserIdx >= 0 ? lastUserIdx : rawMessages.length;
    return overflow === "summarize" ? summarizeBefore(before) : truncateBefore(before, total);
  }

  /** The summary message that leads the window, left out when it came back with `resumed`. */
  function leadingMessages(withRestoredSummary: boolean): Message[] {
    return summary && (withRestoredSummary || !summaryRestored) ? [summaryMessage(summary)] : [];
  }

  function getMessages(): Message[] {
    return [...leadingMessages(true), ...rawMessages];
  }

  return {
    addUserMessage: (content, context) => add(context === undefined ? { role: "user", content } : { role: "user", content, context }),
    addAssistantMessage: (content: string, calls?: CallRecord[]) =>
      add(calls !== undefined && calls.length > 0 ? { role: "assistant", content, calls } : { role: "assistant", content }),
    replaceLastAssistantMessage: (content) => {
      const last = rawMessages[rawMessages.length - 1];
      if (last?.role === "assistant") rawMessages[rawMessages.length - 1] = { ...last, content };
    },
    getMessages,
    getCapturable: () => [...leadingMessages(false), ...rawMessages.slice(restoredCount)],
    getCharCount: () => getMessages().reduce((sum, m) => sum + messageChars(m), 0),
  };
}
