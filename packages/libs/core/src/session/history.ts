/**
 * What a turn reads of its session's conversation and adds to it
 * (`SessionHistory`), and what a session keeps when its context profile
 * names no plugin to keep the conversation: nothing beyond the turn itself
 * (`createTurnOnlyConversation`).
 *
 * Keeping a conversation (a window that shortens itself, picking up a
 * reopened one) is a plugin's (`ConversationOwner`, see `conversations.ts`).
 *
 * Used by: `session/conversations.ts`, which opens one per session;
 * `session/agent-turn.ts` and `router/turn-runner.ts`, which read and add to it.
 */

import type { ContextPrimer } from "./context-primer.ts";
import type { CallRecord } from "./call-record.ts";
import type { CompressionReport, ConversationMessage } from "@mercury-fw/plugin-types";

/**
 * A single turn's worth of conversation content, the contract's
 * `ConversationMessage`. `calls`, on an answer, are
 * the tool calls it was written from, reduced (`call-record.ts`): absent when
 * there were none. `context`, on a person's message, is what the
 * instance's `turn` context layers put in front of it (`../context/context.ts`):
 * the model reads it there on every later call too, so each call starts with
 * the previous one and the model's cache of it holds; everything else (the
 * archive, the memory, the plugins' hooks, the summary) reads `content` only.
 */
export type Message = ConversationMessage;

/** A session's conversation as the turn uses it: the contract's `Conversation`, plus what the core adds. */
export type SessionHistory = {
  /** Appends the person's message, with the context the model reads in front of it. */
  addUserMessage(content: string, context?: string): Promise<CompressionReport | void>;
  /** Appends an answer with the tool calls it was written from. */
  addAssistantMessage(content: string, calls?: CallRecord[]): Promise<CompressionReport | void>;
  /** Overwrites the last message with `content`, keeping its calls, when it's an answer (a post-turn guard rewrote it). */
  replaceLastAssistantMessage(content: string): void;
  /**
   * What the person's earlier conversations left for this one (see
   * `context-primer.ts`), or undefined. Never among the messages: the turn
   * runner gives it to the model as background in the prompt, so it's never
   * taken for the assistant's own words, nor captured again as part of this
   * conversation.
   */
  primer(): ContextPrimer | undefined;
  /** The messages the next model call reads. */
  getMessages(): Message[];
  /** How long `getMessages()` is, calls counted as JSON: for a channel showing how full the conversation is. */
  getCharCount(): number;
  /** What the conversation added since it was opened, without what a reopening brought back: what the memory may still have to learn. */
  getCapturable(): Message[];
};

/** How much of the conversation `m` takes: its text, its context and, as JSON, its calls. */
export function messageChars(m: Message): number {
  return m.content.length + (m.context?.length ?? 0) + (m.calls === undefined ? 0 : JSON.stringify(m.calls).length);
}

/**
 * The conversation of a session whose profile names no plugin to keep one:
 * the model reads only the current turn (the person's message and what the
 * turn adds after it), while every message of the session stays capturable
 * for the memory until the session closes.
 */
export function createTurnOnlyConversation(): Omit<SessionHistory, "primer"> {
  const all: Message[] = [];
  // Where the current turn starts in `all`.
  let turnStart = 0;
  const current = () => all.slice(turnStart);
  return {
    addUserMessage: async (content, context) => {
      turnStart = all.length;
      all.push(context === undefined ? { role: "user", content } : { role: "user", content, context });
    },
    addAssistantMessage: async (content, calls) => {
      all.push(calls !== undefined && calls.length > 0 ? { role: "assistant", content, calls } : { role: "assistant", content });
    },
    replaceLastAssistantMessage: (content) => {
      const last = all[all.length - 1];
      if (last?.role === "assistant") all[all.length - 1] = { ...last, content };
    },
    getMessages: current,
    getCharCount: () => current().reduce((sum, m) => sum + messageChars(m), 0),
    getCapturable: () => [...all],
  };
}
