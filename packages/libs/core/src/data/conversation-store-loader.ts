/**
 * Builds the conversation store an app declares as `conversationStore` in
 * `mercury.config.ts` — the store's sibling of `./vector-index-loader.ts`.
 * It knows no store: Qdrant or anything else lives in its own package.
 *
 * Fail-soft: a store written for another contract, or a `build()` that
 * throws, leaves the instance without a store, logged, and the instance
 * starts anyway. Without a store nothing is archived: no conversations to
 * reopen or list, no titles, no `recall_verbatim`. What goes in it is the
 * plugins' (`@mercury-fw/archive`, `@mercury-fw/titles`): a store none of
 * them asks for gets a line at startup (`unusedStoreWarning`).
 */
import { CONVERSATION_STORE_API_VERSION, type ConversationStore, type ConversationStorePlugin } from "@mercury-fw/channel-types";
import type { PluginNeed } from "@mercury-fw/plugin-types";

/** The store `plugin` builds, or `undefined` when there's none or it can't be used (see the module comment). */
export function loadConversationStore(
  plugin: ConversationStorePlugin | undefined,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void },
): ConversationStore | undefined {
  if (plugin === undefined) return undefined;
  if (plugin.apiVersion !== CONVERSATION_STORE_API_VERSION) {
    ctx.log(
      `conversation store "${plugin.name}" not activated: apiVersion ${plugin.apiVersion} ` +
        `incompatible with this core (supports ${CONVERSATION_STORE_API_VERSION}); no archive, no resumed conversations, no titles`,
    );
    return undefined;
  }
  try {
    return plugin.build({ env: ctx.env, log: ctx.log });
  } catch (err) {
    ctx.log(`conversation store "${plugin.name}" failed to load: ${err instanceof Error ? err.message : String(err)}; no archive, no resumed conversations, no titles`);
    return undefined;
  }
}

/**
 * The startup line for a store declared as `name` that no plugin among
 * `plugins` needs (`needs: ["conversationStore"]`), whose writing is theirs:
 * it would stay empty. `undefined` when no store is declared, or one needs it.
 */
export function unusedStoreWarning(name: string | undefined, plugins: Array<{ name: string; needs?: PluginNeed[] }>): string | undefined {
  if (name === undefined || plugins.some((p) => p.needs?.includes("conversationStore"))) return undefined;
  return (
    `conversation store "${name}" declared, but no plugin uses it (needs: ["conversationStore"]): ` +
    "nothing is archived, no conversation is reopened or titled; declare archive() to keep what is said"
  );
}
