/**
 * The __TITLE__ context strategy: the conversation a context profile keeps
 * (its `conversation`), and so everything the model reads of it. This one
 * keeps the latest exchanges within a size (`window.ts`), in memory, one
 * conversation per session. Written by `mfw plugin create` as a starting
 * point: the four optional methods at the bottom of `conversationOf` are the
 * other places a strategy decides what the model reads, each written here to
 * change nothing.
 */
import type { Conversation, Plugin } from "@mercury-fw/kit";
import { createWindow, type Window } from "./window.ts";

export type __PASCAL__Options = {
  /** The most the model reads of the conversation, in characters. 40,000 unless given. */
  maxChars?: number;
};

/** The conversation the core uses for one session, over its window. */
export function conversationOf(window: Window): Conversation {
  return {
    getMessages: () => window.messages(),
    addUserMessage: async (content, context) => window.add({ role: "user", content, ...(context === undefined ? {} : { context }) }),
    addAssistantMessage: async (content, calls) => window.add({ role: "assistant", content, ...(calls === undefined || calls.length === 0 ? {} : { calls }) }),
    replaceLastAssistantMessage: (content) => window.replaceLastAnswer(content),
    getCharCount: () => window.chars(),
    // What a memory may still learn from: everything this session added.
    getCapturable: () => window.added(),

    // What the model reads of a tool's output inside the turn, instead of the
    // output: `undefined` leaves the output as it is. A strategy keeping long
    // outputs elsewhere returns a pointer to them here.
    toolOutput: (_call, _content) => undefined,
    // What the model reads of a past call on later turns: `shown` is what the
    // core would show, the call's reduced result.
    pastCall: (_call, shown) => shown,
    // What goes in front of the person's message at each turn: nothing here.
    turnIndex: () => undefined,
    // The session layers' blocks in the system prompt: as the layers wrote them.
    placeLayers: (layers) => layers,
  };
}

/** The strategy. Declare it as a context profile's `conversation`. */
export function __EXPORT__(options: __PASCAL__Options = {}): Plugin {
  const maxChars = options.maxChars ?? 40_000;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(`__NAME__: maxChars is a whole number of characters, at least 1 (got ${maxChars})`);
  }
  return {
    // The contract this strategy is written for, as a literal: importing
    // PLUGIN_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    description: "Keeps the conversation the model reads: the latest exchanges, within a size.",
    actsAs: "anyone",
    build: () => {
      const windows = new Map<string, Window>();
      return {
        conversation: {
          // A reopened conversation starts empty here: to bring back what the
          // conversation store kept, see `resumeConversation` in
          // @mercury-fw/conversation-window.
          open: async (req) => {
            const window = createWindow(maxChars);
            windows.set(req.sessionKey, window);
            return conversationOf(window);
          },
          close: (sessionKey) => {
            windows.delete(sessionKey);
          },
        },
      };
    },
  };
}
