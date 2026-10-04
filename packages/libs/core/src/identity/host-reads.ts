/**
 * The read-only getters the core hands a channel that exposes an API (the HTTP
 * surface), each scoped to the caller: their own conversations, confirmations,
 * tool calls and memory, and the wiki as they see it (the common area plus
 * their own area). The channel authenticates; what the person can see is
 * decided here, from their user key. Only the plugin manifest and health stay
 * global.
 *
 * A getter answers `null` for something that isn't there for this person: a
 * wiki path outside their scope (or missing), a collection that isn't kept per
 * person. The channel turns that into its own "not found" or "bad request".
 */
import type { ChannelHostReads, Principal } from "@mercury-fw/channel-types";
import type { ConfirmationStore } from "@mercury-fw/confirm-engine";
import { scrollCollection, type ScrollableQdrantClient } from "../admin/qdrant-scroll.ts";
import type { QdrantClientLike } from "../memory/episodic-store.ts";
import { listVerbatimBySession, listVerbatimSessions } from "../memory/verbatim-archive-store.ts";
import { getToolLog } from "../session/tool-log-buffer.ts";
import { userKey } from "./user-key.ts";
import { grepVisible, listVisible, readVisible } from "./vault-access.ts";

export type HostReadsDeps = {
  vaultPath: string;
  qdrant: QdrantClientLike & ScrollableQdrantClient;
  /** The collections whose points carry a person's `userId`: the only ones `memoryScroll` opens. */
  collections: { verbatim: string; episodic: string; semanticFacts: string };
  confirmationStore: ConfirmationStore;
  manifest: () => unknown;
  health: () => Promise<unknown>;
};

/** Builds the per-person `ChannelHostReads` over this instance's vault, Qdrant and stores. */
export function createHostReads(deps: HostReadsDeps): ChannelHostReads {
  const { vaultPath, qdrant, collections } = deps;
  const perPerson = new Set([collections.verbatim, collections.episodic, collections.semanticFacts]);
  const scope = (principal: Principal) => ({ vaultPath, key: userKey(principal) });

  return {
    manifest: deps.manifest,
    health: deps.health,
    pendingConfirmations: (principal) => deps.confirmationStore.pending(userKey(principal)),
    conversation: (principal, sessionKey, limit, offset) =>
      listVerbatimBySession(qdrant, collections.verbatim, { userId: userKey(principal), sessionKey, limit, offset }),
    conversations: (principal, limit) => listVerbatimSessions(qdrant, collections.verbatim, { userId: userKey(principal), limit }),
    wikiList: (principal) => listVisible(scope(principal)),
    wikiRead: (principal, path) => readVisible(scope(principal), path).catch(() => null),
    wikiGrep: (principal, pattern) => grepVisible(scope(principal), pattern),
    memoryScroll: async (principal, collection, limit, offset) =>
      perPerson.has(collection) ? scrollCollection(qdrant, collection, { limit, offset, userId: userKey(principal) }) : null,
    toolLog: (principal) => getToolLog({ owner: userKey(principal) }),
  };
}
