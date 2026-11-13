import { describe, expect, it } from "bun:test";
import { CONVERSATION_STORE_API_VERSION, type ConversationStorePlugin } from "@mercury-fw/channel-types";
import { fakeConversationStore } from "../memory/__fixtures__/fake-conversation-store.ts";
import { loadConversationStore, unusedStoreWarning } from "./conversation-store-loader.ts";

function plugin(overrides: Partial<ConversationStorePlugin> = {}): ConversationStorePlugin {
  return { apiVersion: CONVERSATION_STORE_API_VERSION, name: "fake", build: () => fakeConversationStore(), ...overrides };
}

describe("loadConversationStore", () => {
  it("is no store, and says nothing, when the config declares none", () => {
    const logs: string[] = [];
    expect(loadConversationStore(undefined, { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("builds the declared store with the env and the logger", () => {
    const store = fakeConversationStore();
    const seen: Array<{ env: unknown }> = [];
    const env = { QDRANT_URL: "http://q:6333" };
    const built = loadConversationStore(plugin({ build: (ctx) => (seen.push({ env: ctx.env }), store) }), { env, log: () => {} });
    expect(built).toBe(store);
    expect(seen).toEqual([{ env }]);
  });

  it("leaves out a store written for another contract, saying why", () => {
    const logs: string[] = [];
    expect(loadConversationStore(plugin({ apiVersion: 99 }), { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual([
      `conversation store "fake" not activated: apiVersion 99 incompatible with this core (supports ${CONVERSATION_STORE_API_VERSION}); no archive, no resumed conversations, no titles`,
    ]);
  });

  it("leaves out a store whose build throws, saying why, and the instance starts", () => {
    const logs: string[] = [];
    const failing = plugin({
      build: () => {
        throw new Error("bad URL");
      },
    });
    expect(loadConversationStore(failing, { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual(['conversation store "fake" failed to load: bad URL; no archive, no resumed conversations, no titles']);
  });
});

// #393: what goes in the store is the plugins' (the archive, the titles): a
// store none of them asks for stays empty, and nothing else says why.
describe("unusedStoreWarning", () => {
  it("warns about a declared store no loaded plugin needs, naming it", () => {
    expect(unusedStoreWarning("qdrant", [{ name: "jira" }, { name: "wiki", needs: ["vectorIndex"] }])).toBe(
      'conversation store "qdrant" declared, but no plugin uses it (needs: ["conversationStore"]): nothing is archived, no conversation is reopened or titled; declare archive() to keep what is said',
    );
  });

  it("says nothing when a plugin needs it, or when none is declared", () => {
    expect(unusedStoreWarning("qdrant", [{ name: "archive", needs: ["conversationStore"] }])).toBeUndefined();
    expect(unusedStoreWarning(undefined, [{ name: "jira" }])).toBeUndefined();
  });
});
