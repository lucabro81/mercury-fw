/**
 * A test conversation that keeps every message and never shortens: what a
 * turn sees of a conversation kept by a window plugin that never had to
 * compress.
 */
import { messageChars, type Message, type SessionHistory } from "../history.ts";

/** A `SessionHistory` keeping every message, with no primer. */
export function keptHistory(): SessionHistory {
  const messages: Message[] = [];
  return {
    addUserMessage: async (content, context) => void messages.push(context === undefined ? { role: "user", content } : { role: "user", content, context }),
    addAssistantMessage: async (content, calls) =>
      void messages.push(calls !== undefined && calls.length > 0 ? { role: "assistant", content, calls } : { role: "assistant", content }),
    replaceLastAssistantMessage: (content) => {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") messages[messages.length - 1] = { ...last, content };
    },
    primer: () => undefined,
    getMessages: () => [...messages],
    getCharCount: () => messages.reduce((sum, m) => sum + messageChars(m), 0),
    getCapturable: () => [...messages],
  };
}
