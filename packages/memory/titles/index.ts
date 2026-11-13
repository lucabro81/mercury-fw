/**
 * `@mercury-fw/titles`: names each conversation in the instance's
 * conversation store, once, after the first turn the person wrote, from what
 * they wrote and the answer (`./titler.ts`), so a channel listing their
 * conversations shows them by name. A title the person chose is never
 * replaced. The model call is background work (`ctx.job`, on the instance's
 * `background` model); the operator's turns (the terminal) are never titled.
 */
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { createConversationTitler } from "./titler.ts";

/** The titles plugin (see the module comment). */
export function titles(): Plugin {
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "titles",
    description: "Gives each conversation a short title, so a person finds it again in their list.",
    actsAs: "anyone",
    needs: ["conversationStore"],
    build: (ctx) => {
      const store = ctx.conversations;
      if (store === undefined) throw new Error("titles: no conversation store (needs: conversationStore)");
      const title = createConversationTitler({
        model: ctx.backgroundModel ?? ctx.model,
        hasTitle: async (userId, sessionKey) => (await store.titles({ userId, sessionKeys: [sessionKey] })).some((t) => t.sessionKey === sessionKey),
        setTitle: (userId, sessionKey, text) => store.setTitle({ userId, sessionKey, title: text, source: "generated", updatedAt: new Date().toISOString() }),
        log: ctx.log,
      });
      const job = ctx.job ?? (<T,>(_name: string, _urgency: string, fn: () => Promise<T>) => fn());
      return {
        afterTurn: async (turn) => {
          if (turn.operator || turn.input.trim() === "") return;
          await job("title", "soon", () =>
            title({ sessionKey: turn.sessionKey, userId: turn.person.key, question: turn.input, answer: turn.answer }),
          );
        },
      };
    },
  };
}
