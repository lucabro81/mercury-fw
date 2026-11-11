/**
 * The read-only getters the core hands a channel that exposes an API (the HTTP
 * surface), each scoped to the caller: their own conversations, confirmations,
 * tool calls and memory, the wiki as they see it (the common area plus their
 * own area), and the plugins they're offered (the manifest). The channel
 * authenticates; the core identifies the person (`identity/people.ts`) and
 * decides what they can see. Only health stays global.
 *
 * A getter answers `null` for something that isn't there for this person: a
 * wiki path outside their scope (or missing), a collection that isn't kept per
 * person, anything at all for someone the core doesn't admit. The channel
 * turns that into its own "not found" or "bad request".
 */
import type { ChannelHostReads, Principal, VectorIndex } from "@mercury-fw/channel-types";
import type { ConfirmationStore } from "@mercury-fw/confirm-engine";
import { EPISODIC_SPACE } from "../memory/episodic-store.ts";
import { SEMANTIC_FACTS_SPACE } from "../memory/semantic-facts-store.ts";
import { VERBATIM_SPACE } from "../memory/verbatim-archive-store.ts";
import type { QdrantClientLike } from "../memory/qdrant-client.ts";
import { listVerbatimBySession, listVerbatimSessions } from "../memory/verbatim-archive-store.ts";
import type { ConversationTitle } from "../memory/conversation-titles-store.ts";
import { getToolLog } from "../session/tool-log-buffer.ts";
import { createPeople, type People, type TurnWho } from "./people.ts";
import { grepVisible, listVisible, readVisible } from "./vault-access.ts";

export type HostReadsDeps = {
  vaultPath: string;
  qdrant: QdrantClientLike;
  /** The archive's collection on Qdrant. */
  collections: { verbatim: string };
  /** Where `memoryScroll` reads; without one there's no memory to scroll. */
  index?: VectorIndex;
  confirmationStore: ConfirmationStore;
  /** The manifest of what `who` is offered. */
  manifest: (who: TurnWho) => unknown;
  health: () => Promise<unknown>;
  /** Who a caller is; defaults to no directory (whoever the channel says). */
  identify?: People["identify"];
  /** How the person with `key` asked to be called (`profiles.ts`); nobody has a name when absent. */
  preferredName?: (key: string) => string | undefined;
  /** The language the person with `key` saved (`profiles.ts`); nobody has one when absent. */
  preferredLanguage?: (key: string) => string | undefined;
  /** The time zone the person with `key` saved (`profiles.ts`); nobody has one when absent. */
  preferredTimeZone?: (key: string) => string | undefined;
  /** The titles of the person `key`'s conversations `sessionKeys` (`conversation-titles-store.ts`); no conversation has one when absent. */
  titlesOf?: (key: string, sessionKeys: string[]) => Promise<Map<string, ConversationTitle>>;
};

/** Builds the per-person `ChannelHostReads` over this instance's vault, Qdrant, vector index and stores. */
export function createHostReads(deps: HostReadsDeps): ChannelHostReads {
  const { vaultPath, qdrant, collections } = deps;
  // The spaces whose points carry a person's `userId`: the only ones `memoryScroll` opens.
  const perPerson = new Set([VERBATIM_SPACE, EPISODIC_SPACE, SEMANTIC_FACTS_SPACE]);
  const identify = deps.identify ?? createPeople({ directory: "none" }).identify;

  /** Runs `read` for the person `principal` is, or answers `null` when the core doesn't admit them. */
  const forPerson =
    <A extends unknown[]>(read: (who: TurnWho, ...args: A) => unknown) =>
    async (principal: Principal, ...args: A): Promise<unknown> => {
      const identified = await identify(principal);
      if (!identified.ok) return null;
      return read({ person: identified.person, operator: identified.operator }, ...args);
    };
  const scope = (who: TurnWho) => ({ vaultPath, key: who.person.key });
  /** The titles of `sessionKeys` for `who`; none when the instance keeps no titles or they can't be read (enrichment, like the archive). */
  const titles = async (who: TurnWho, sessionKeys: string[]): Promise<Map<string, ConversationTitle>> => {
    if (deps.titlesOf === undefined || sessionKeys.length === 0) return new Map();
    try {
      return await deps.titlesOf(who.person.key, sessionKeys);
    } catch (err) {
      console.error(`[titles] read failed, listed without titles: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  };

  return {
    manifest: forPerson((who) => deps.manifest(who)),
    health: deps.health,
    pendingConfirmations: forPerson((who) => deps.confirmationStore.pending(who.person.key)),
    conversation: forPerson(async (who, sessionKey: string, limit: number, offset?: string) => {
      const [page, titled] = await Promise.all([
        listVerbatimBySession(qdrant, collections.verbatim, { userId: who.person.key, sessionKey, limit, offset }),
        titles(who, [sessionKey]),
      ]);
      const title = titled.get(sessionKey)?.title;
      return title === undefined ? page : { ...page, title };
    }),
    conversations: forPerson(async (who, limit: number) => {
      const { conversations } = await listVerbatimSessions(qdrant, collections.verbatim, { userId: who.person.key, limit });
      const titled = await titles(who, conversations.map((c) => c.sessionKey));
      return {
        conversations: conversations.map((c) => {
          const title = titled.get(c.sessionKey)?.title;
          return title === undefined ? c : { ...c, title };
        }),
      };
    }),
    wikiList: forPerson((who) => listVisible(scope(who))),
    wikiRead: forPerson((who, path: string) => readVisible(scope(who), path).catch(() => null)),
    wikiGrep: forPerson((who, pattern: string) => grepVisible(scope(who), pattern)),
    memoryScroll: forPerson(async (who, space: string, limit: number, offset?: string) => {
      if (deps.index === undefined || !perPerson.has(space)) return null;
      const page = await deps.index.scroll(space, {
        where: { userId: who.person.key },
        limit,
        ...(offset === undefined ? {} : { cursor: offset }),
      });
      return { points: page.points, nextOffset: page.next ?? null };
    }),
    toolLog: forPerson((who) => getToolLog({ owner: who.person.key })),
    me: forPerson((who) => ({
      name: deps.preferredName?.(who.person.key) ?? null,
      language: deps.preferredLanguage?.(who.person.key) ?? null,
      timeZone: deps.preferredTimeZone?.(who.person.key) ?? null,
    })),
  };
}
