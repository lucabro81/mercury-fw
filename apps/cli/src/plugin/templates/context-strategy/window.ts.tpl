/**
 * The window of one conversation: the messages the model reads, within a size
 * in characters. Past it, the oldest exchanges go (a person's message and the
 * answers after it), the newest message always stays, and what went is
 * reported to the core, which records it in the traces. Change this to change
 * what the model keeps reading: summarize instead of dropping, keep part of it
 * elsewhere.
 */
import type { CompressionReport, ConversationMessage } from "@mercury-fw/kit";

/** A message's size as the window counts it: its text and what the context layers put in front of it. */
export function messageChars(message: ConversationMessage): number {
  return message.content.length + (message.context?.length ?? 0);
}

export type Window = {
  /** The messages the model reads, oldest first. */
  messages: () => ConversationMessage[];
  /** Every message added since the window was made, dropped ones included. */
  added: () => ConversationMessage[];
  /** Adds `message`; reports what went when the window dropped any to stay within its size. */
  add: (message: ConversationMessage) => CompressionReport | undefined;
  /** Replaces the text of the newest answer, if there is one. */
  replaceLastAnswer: (content: string) => void;
  /** The size of what the model reads. */
  chars: () => number;
};

/** A window of at most `maxChars` characters. */
export function createWindow(maxChars: number): Window {
  let messages: ConversationMessage[] = [];
  const added: ConversationMessage[] = [];
  const chars = () => messages.reduce((total, m) => total + messageChars(m), 0);

  return {
    messages: () => [...messages],
    added: () => [...added],
    chars,
    add: (message) => {
      messages.push(message);
      added.push(message);
      const charsBefore = chars();
      if (charsBefore <= maxChars) return undefined;
      const started = Date.now();
      let dropped = 0;
      while (chars() > maxChars && messages.length > 1) {
        // The oldest exchange: the first message and the answers after it, never the newest message.
        let end = 1;
        while (end < messages.length - 1 && messages[end]!.role === "assistant") end++;
        messages = messages.slice(end);
        dropped += end;
      }
      return { messages: dropped, charsBefore, charsAfter: chars(), durationMs: Date.now() - started, outcome: "done" };
    },
    replaceLastAnswer: (content) => {
      const last = messages.findLastIndex((m) => m.role === "assistant");
      if (last !== -1) messages[last] = { ...messages[last]!, content };
    },
  };
}
