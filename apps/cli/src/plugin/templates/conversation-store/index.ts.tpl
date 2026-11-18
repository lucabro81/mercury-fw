/**
 * The __TITLE__ conversation store: every message of every conversation, word
 * for word, and each conversation's title, read back by person and in time
 * order. Written by `mfw plugin create` as a starting point: this one keeps
 * them in memory, so they're gone on a restart; a real store goes behind the
 * same methods, talking to its database. Every read is scoped to one person.
 * Every method may reject when the database can't be reached: the core takes
 * that as the store being away for now.
 */
import type { ConversationStore, ConversationStorePlugin, StoredMessage, StoredTitle } from "@mercury-fw/kit";

/** A store kept in memory. */
export function createStore(): ConversationStore {
  const messages: StoredMessage[] = [];
  const titles = new Map<string, StoredTitle>();
  const titleKey = (userId: string, sessionKey: string) => JSON.stringify([userId, sessionKey]);
  const byTime = (a: StoredMessage, b: StoredMessage) => a.timestamp.localeCompare(b.timestamp);
  return {
    ready: async () => {},
    append: async (message) => {
      messages.push(message);
    },
    messages: async (q) => {
      const all = messages.filter((m) => m.userId === q.userId && m.sessionKey === q.sessionKey).sort(byTime);
      if (q.order === "desc") all.reverse();
      // The cursor is where the next page starts.
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      const next = start + q.limit < all.length ? String(start + q.limit) : undefined;
      return { messages: all.slice(start, start + q.limit), ...(next === undefined ? {} : { next }) };
    },
    recent: async (q) =>
      messages
        .filter((m) => m.userId === q.userId)
        .sort(byTime)
        .reverse()
        .slice(0, q.limit),
    setTitle: async (title) => {
      titles.set(titleKey(title.userId, title.sessionKey), title);
    },
    titles: async (q) => q.sessionKeys.flatMap((key) => titles.get(titleKey(q.userId, key)) ?? []),
    health: async () => ({ ok: true }),
  };
}

/** The store. Declare it as `conversationStore`. */
export function __EXPORT__(): ConversationStorePlugin {
  return {
    // The contract this store is written for, as a literal: importing
    // CONVERSATION_STORE_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    // A store that can't work throws here: the core runs without one.
    build: () => createStore(),
  };
}
