/**
 * Layer 1 conversation memory: a sliding window of raw messages that
 * summarizes itself once it grows too large, instead of growing
 * unbounded across a long conversation.
 *
 * Why it exists: without a bound, a multi-turn conversation eventually
 * overflows the model's context window. This is the only memory layer
 * Mercury has in M1 — Layer 2 (wiki) and Layer 3 (episodic/Qdrant) are
 * later milestones, pure enrichment that the system must work without.
 *
 * Used by: `src/session/agent-turn.ts` (`runTurn`), which appends each
 * turn's user/assistant messages here and reads `getMessages()` to build
 * the prompt for the next generation call. `src/session/summarizer.ts`
 * supplies the `summarize` function injected into `createSessionHistory`.
 */

import type { ContextPrimer } from "./context-primer.ts";

/** A single turn's worth of conversation content. */
export type Message = { role: "user" | "assistant"; content: string };

/**
 * Character-count threshold (not a real tokenizer count — a `chars/4`
 * estimate is close enough given the wide margin in the model's context
 * budget) above which the raw message history gets summarized and
 * replaced. Exported so tests can construct fixtures that land exactly
 * at, or just past, the boundary.
 */
export const MAX_HISTORY_CHARS = 60_000;

/**
 * Mutable conversation history for a single ongoing conversation
 * (one per channel/space — see `src/index.ts`, never shared across
 * conversations).
 */
export type SessionHistory = {
  /** Appends a user turn, summarizing first if this push crosses the threshold. */
  addUserMessage(content: string): Promise<void>;
  /** Appends an assistant turn, summarizing first if this push crosses the threshold. */
  addAssistantMessage(content: string): Promise<void>;
  /**
   * Overwrites the most recently added message with `content`, in place,
   * if it exists and is an assistant message — used when a turn's
   * assistant text is corrected after already being recorded (see
   * turn-runner.ts's issue-list correction). No-ops if there is no last
   * message, or if it isn't an assistant message (defensive; shouldn't
   * happen given how this is called). Deliberately synchronous and skips
   * the summarization threshold check entirely: this replaces content
   * already counted by the original `addAssistantMessage` call, it isn't
   * new content being added.
   */
  replaceLastAssistantMessage(content: string): void;
  /**
   * What the person's earlier conversations left for this one (see
   * `context-primer.ts`), or undefined. Never among the messages: the turn
   * runner gives it to the model as background in the prompt, so it's never
   * taken for the assistant's own words, nor captured again as part of this
   * conversation.
   */
  primer(): ContextPrimer | undefined;
  /**
   * The messages to feed into the next model call: the current summary
   * (if one exists, as a synthetic leading message) followed by the raw
   * messages accumulated since the last summarization.
   */
  getMessages(): Message[];
  /**
   * Total character length of what `getMessages()` would currently
   * return — a live read on how close this conversation is to
   * `MAX_HISTORY_CHARS` (and so to triggering summarization). Exposed so
   * a channel can show this to a human, e.g. to tell apart "the model
   * lost track of something" from "the context is actually near full".
   */
  getCharCount(): number;
  /**
   * What `getMessages()` returns minus what a resumed conversation brought
   * back (see `createSessionHistory`'s `resumed`): it's already in memory,
   * so whatever mirrors this history to memory reads this instead, and a
   * resumed conversation is never captured twice. The same as `getMessages()`
   * once a compression folded the resumed part into a new summary.
   */
  getCapturable(): Message[];
};

/** What a resumed conversation brings back: the summary of its older part, if any, and its newest messages. */
export type ResumedConversation = { summary?: string; messages: Message[] };

/** Wraps a summary string as the synthetic leading message `getMessages()` prepends. */
function summaryMessage(summary: string): Message {
  return { role: "assistant", content: `Earlier conversation summary: ${summary}` };
}

/**
 * Creates an empty `SessionHistory`.
 *
 * @param summarize - Called with the messages that precede the current
 *   user turn (any prior summary re-injected as a leading message) whenever
 *   a single append pushes the total content length over
 *   `MAX_HISTORY_CHARS`. Its return value becomes the new summary; the
 *   trailing run from the last user message onward is retained as the raw
 *   window rather than cleared, so the current turn is never summarized away
 *   (a model call always follows `addUserMessage`, and the summary
 *   leading message is `role:"assistant"` — folding the user turn
 *   into them would hand the model a user-less array). The threshold check
 *   runs after every individual append (not once per turn), so the crossing
 *   point is caught precisely regardless of whether it's the user or
 *   assistant message that tips it over. A lone crossing user message with
 *   nothing before it is left live and `summarize` is not called.
 * @param onBeforeCompress - Optional, called synchronously with the exact
 *   same batch `summarize` is about to receive, right before it's
 *   compressed out of the live context — a second, independent signal a
 *   caller can mirror to somewhere durable (see `idle-session-cron.ts`'s
 *   shared capture function) before that content stops being directly
 *   visible to the model. Fire-and-forget on purpose: this function must
 *   never block or fail Layer 1's own compression on an external write.
 * @param primer - Optional, set once at creation from the person's earlier
 *   conversations (see `context-primer.ts`). Held as its own state, apart
 *   from the messages and from `summary`, and returned by `primer()`.
 * @param resumed - Optional, a conversation picked up again after its history
 *   was dropped (see `session/resume.ts`): its summary becomes this history's
 *   summary and its messages lead the raw window, so the model sees the
 *   conversation as if it had never been closed. Both are already in memory:
 *   `getCapturable()` and `onBeforeCompress` leave them out, while `summarize`
 *   still gets them, so the first compression folds them into a summary of
 *   the whole conversation.
 */
export function createSessionHistory(
  summarize: (messages: Message[]) => Promise<string>,
  onBeforeCompress?: (messages: Message[]) => void,
  primer?: ContextPrimer,
  resumed?: ResumedConversation,
): SessionHistory {
  let rawMessages: Message[] = [...(resumed?.messages ?? [])];
  let summary: string | null = resumed?.summary || null;
  // How much of the history's head came back with `resumed`, until a
  // compression folds it into a new summary.
  let restoredCount = rawMessages.length;
  let summaryRestored = summary !== null;

  async function add(message: Message): Promise<void> {
    rawMessages.push(message);

    const total = rawMessages.reduce((sum, m) => sum + m.content.length, 0);
    if (total > MAX_HISTORY_CHARS) {
      // Retain the trailing run from the last user message onward instead of
      // clearing everything: getMessages() for a model call always follows an
      // addUserMessage, and the summary leading message is
      // role:"assistant", so summarizing the current user turn away would hand
      // Ollama a user-less array ("no user query found in messages") — bug #19.
      // Compress only what precedes that turn; if nothing precedes it (a lone
      // oversized user message), leave it live — its question can't be summarized.
      const lastUserIdx = rawMessages.findLastIndex((m) => m.role === "user");
      const toCompress = lastUserIdx >= 0 ? rawMessages.slice(0, lastUserIdx) : rawMessages;
      const retained = lastUserIdx >= 0 ? rawMessages.slice(lastUserIdx) : [];
      if (toCompress.length === 0) {
        return;
      }
      const batch = summary ? [summaryMessage(summary), ...toCompress] : toCompress;
      // The resumed part is already in memory: mirror only what's new.
      const mirrored = [...(summary && !summaryRestored ? [summaryMessage(summary)] : []), ...toCompress.slice(restoredCount)];
      if (mirrored.length > 0) onBeforeCompress?.(mirrored);
      summary = await summarize(batch);
      rawMessages = retained;
      restoredCount = Math.max(0, restoredCount - toCompress.length);
      summaryRestored = false;
    }
  }

  /** The summary message that leads the history, left out when it came back with `resumed`. */
  function leadingMessages(withRestoredSummary: boolean): Message[] {
    const leading: Message[] = [];
    if (summary && (withRestoredSummary || !summaryRestored)) {
      leading.push(summaryMessage(summary));
    }
    return leading;
  }

  function getMessages(): Message[] {
    return [...leadingMessages(true), ...rawMessages];
  }

  return {
    addUserMessage: (content) => add({ role: "user", content }),
    addAssistantMessage: (content) => add({ role: "assistant", content }),
    replaceLastAssistantMessage: (content) => {
      const last = rawMessages[rawMessages.length - 1];
      if (last?.role === "assistant") {
        rawMessages[rawMessages.length - 1] = { role: "assistant", content };
      }
    },
    primer: () => (primer && (primer.current || primer.recap) ? primer : undefined),
    getMessages,
    getCapturable: () => [...leadingMessages(false), ...rawMessages.slice(restoredCount)],
    getCharCount: () => getMessages().reduce((sum, m) => sum + m.content.length, 0),
  };
}
