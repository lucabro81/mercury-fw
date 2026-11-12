/**
 * An in-memory `ConversationStore` for the core's tests: messages filtered by
 * person and conversation, ordered by `timestamp`, paged by numeric cursors;
 * titles one per person and conversation. `calls` records what the core
 * asked, `fail` makes every call reject (a store that's away).
 */
import type { ConversationStore, StoredMessage, StoredTitle } from "@mercury-fw/channel-types";

export type FakeConversationStore = ConversationStore & {
  stored: StoredMessage[];
  storedTitles: StoredTitle[];
  calls: Array<[string, unknown?]>;
  fail: Error | undefined;
};

/** A fresh fake store holding `seed` (an id given to each message that has none) and `titles`. */
export function fakeConversationStore(seed: Array<Record<string, unknown>> = [], titles: StoredTitle[] = []): FakeConversationStore {
  const store: FakeConversationStore = {
    stored: seed.map((m, i) => ({ id: `m${i}`, ...m }) as StoredMessage),
    storedTitles: [...titles],
    calls: [],
    fail: undefined,
    ready: async () => {
      store.calls.push(["ready"]);
      if (store.fail) throw store.fail;
    },
    append: async (message) => {
      store.calls.push(["append", message]);
      if (store.fail) throw store.fail;
      store.stored.push(message);
    },
    messages: async (q) => {
      store.calls.push(["messages", q]);
      if (store.fail) throw store.fail;
      const sorted = store.stored
        .filter((m) => m.userId === q.userId && m.sessionKey === q.sessionKey)
        .sort((a, b) => (q.order === "asc" ? 1 : -1) * a.timestamp.localeCompare(b.timestamp));
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      const messages = sorted.slice(start, start + q.limit);
      return start + q.limit < sorted.length ? { messages, next: String(start + q.limit) } : { messages };
    },
    recent: async (q) => {
      store.calls.push(["recent", q]);
      if (store.fail) throw store.fail;
      return store.stored
        .filter((m) => m.userId === q.userId)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, q.limit);
    },
    setTitle: async (title) => {
      store.calls.push(["setTitle", title]);
      if (store.fail) throw store.fail;
      store.storedTitles = [...store.storedTitles.filter((t) => t.userId !== title.userId || t.sessionKey !== title.sessionKey), title];
    },
    titles: async (q) => {
      store.calls.push(["titles", q]);
      if (store.fail) throw store.fail;
      return store.storedTitles.filter((t) => t.userId === q.userId && q.sessionKeys.includes(t.sessionKey));
    },
    health: async () => (store.fail ? { ok: false, detail: store.fail.message } : { ok: true }),
  };
  return store;
}
