/**
 * `@mercury-fw/archive`: keeps what is said in the instance's conversation
 * store, every message of every conversation, as the channels read it back to
 * reopen and list a person's conversations. It writes what each turn and
 * each resolved confirmation leaves (`onTurnRecord`, in the shape
 * `archivedMessages` gives), never the operator's (the terminal), and adds
 * nothing to what the model reads.
 */
import { archivedMessages, PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";

/** The archive plugin (see the module comment). */
export function archive(): Plugin {
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "archive",
    description: "Keeps every conversation as it was said, so a person can reopen it later.",
    actsAs: "anyone",
    needs: ["conversationStore"],
    build: (ctx) => {
      const store = ctx.conversations;
      if (store === undefined) throw new Error("archive: no conversation store (needs: conversationStore)");
      return {
        onTurnRecord: async (record) => {
          if (record.operator) return;
          // One after the other: the store reads them back in time order, and a message never waits on a later one.
          for (const message of archivedMessages(record)) await store.append({ id: crypto.randomUUID(), ...message });
        },
      };
    },
  };
}
