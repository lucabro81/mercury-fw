/**
 * Qdrant as Mercury's conversation store: `qdrantConversations()` is what an
 * app declares as `conversationStore` in `mercury.config.ts`. Messages and
 * titles are each a collection of points with a placeholder vector of one
 * dimension: nothing searches them by meaning, every read is a filtered,
 * ordered scroll.
 *
 * Qdrant is reached at `QDRANT_URL` (`http://qdrant:6333` when it's not set).
 * The messages go in `conversation_messages` (`QDRANT_MESSAGES_COLLECTION`),
 * the titles in `conversation_titles` (`QDRANT_TITLES_COLLECTION`), the
 * collection older versions already kept them in.
 *
 * Older versions kept the messages in the archive's collection,
 * `verbatim_archive` (`QDRANT_VERBATIM_COLLECTION`), with their vectors: it
 * stays, the vector index's space to search them in. `ready` copies its
 * points into the messages collection, same ids, as long as the messages
 * collection holds fewer points than it, so a copy that stopped halfway
 * resumes and a finished one isn't done again.
 */
import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  CONVERSATION_STORE_API_VERSION,
  type ConversationStore,
  type ConversationStorePlugin,
  type StoredMessage,
  type StoredTitle,
} from "@mercury-fw/channel-types";

type Match = { value: string } | { any: string[] };
type QdrantFilter = { must: Array<{ key: string; match: Match }> };
type QdrantOffset = string | number | Record<string, unknown> | null | undefined;

/** The slice of `@qdrant/js-client-rest`'s client the store uses. */
export type QdrantConversationsClient = {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(name: string, params: { vectors: { size: number; distance: "Dot" } }): Promise<unknown>;
  createPayloadIndex(name: string, params: { field_name: string; field_schema: "keyword" | "datetime" }): Promise<unknown>;
  count(name: string, params: { exact: true }): Promise<{ count: number }>;
  upsert(name: string, params: { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> }): Promise<unknown>;
  scroll(
    name: string,
    params: {
      filter?: QdrantFilter;
      order_by?: { key: string; direction: "asc" | "desc" };
      limit: number;
      offset?: QdrantOffset;
      with_payload: true;
    },
  ): Promise<{
    points: Array<{ id: string | number; payload?: Record<string, unknown> | null }>;
    next_page_offset?: QdrantOffset;
  }>;
};

/** The vector every point carries: the collections are never searched by meaning. */
const PLACEHOLDER = [1];

/** How many archive points a copy moves per page. */
const COPY_PAGE = 256;

/** The id of the point holding the title of `sessionKey` for `userId`: a name-based UUID (version 5 layout) of the two. */
export function titlePointId(userId: string, sessionKey: string): string {
  const hash = createHash("sha1").update(JSON.stringify([userId, sessionKey])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The cursor for Qdrant's `next_page_offset`: a point id as it is, anything else as JSON; none on the last page. */
function cursorOf(offset: QdrantOffset): string | undefined {
  if (offset === null || offset === undefined) return undefined;
  return typeof offset === "string" ? offset : JSON.stringify(offset);
}

/** The offset a cursor stands for: a number or an object back from JSON, a point id as it is. */
function offsetOf(cursor: string): QdrantOffset {
  if (/^\d+$/.test(cursor) || cursor.startsWith("{")) {
    try {
      return JSON.parse(cursor) as QdrantOffset;
    } catch {
      return cursor;
    }
  }
  return cursor;
}

/** Whether `payload` is a title as `setTitle` stored it. */
function isTitle(payload: Record<string, unknown> | null | undefined): payload is StoredTitle {
  return (
    payload != null &&
    typeof payload.userId === "string" &&
    typeof payload.sessionKey === "string" &&
    typeof payload.title === "string" &&
    typeof payload.source === "string" &&
    typeof payload.updatedAt === "string"
  );
}

/** The store over `client`, its collections named by `env`. */
export function createQdrantConversations(
  client: QdrantConversationsClient,
  env: Record<string, string | undefined>,
  log: (msg: string) => void,
): ConversationStore {
  const messagesCollection = env.QDRANT_MESSAGES_COLLECTION || "conversation_messages";
  const titlesCollection = env.QDRANT_TITLES_COLLECTION || "conversation_titles";
  const archiveCollection = env.QDRANT_VERBATIM_COLLECTION || "verbatim_archive";

  /** Creates `name` when it's missing, and indexes the fields it's read by. */
  const ensure = async (existing: string[], name: string, keys: string[], ordered: string[]) => {
    if (!existing.includes(name)) await client.createCollection(name, { vectors: { size: 1, distance: "Dot" } });
    for (const key of keys) await client.createPayloadIndex(name, { field_name: key, field_schema: "keyword" });
    for (const key of ordered) await client.createPayloadIndex(name, { field_name: key, field_schema: "datetime" });
  };

  /** Copies the archive's points the messages collection lacks (see the module comment). */
  const copyArchive = async (existing: string[]) => {
    if (!existing.includes(archiveCollection)) return;
    const archived = (await client.count(archiveCollection, { exact: true })).count;
    if ((await client.count(messagesCollection, { exact: true })).count >= archived) return;
    let offset: QdrantOffset;
    let copied = 0;
    do {
      const page = await client.scroll(archiveCollection, { limit: COPY_PAGE, ...(offset == null ? {} : { offset }), with_payload: true });
      if (page.points.length > 0) {
        await client.upsert(messagesCollection, {
          points: page.points.map((p) => ({ id: String(p.id), vector: PLACEHOLDER, payload: p.payload ?? {} })),
        });
      }
      copied += page.points.length;
      offset = page.next_page_offset;
    } while (offset !== null && offset !== undefined);
    log(`copied ${copied} messages from ${archiveCollection} into ${messagesCollection}`);
  };

  const filterOf = (userId: string, sessionKey?: string): QdrantFilter => ({
    must: [
      { key: "userId", match: { value: userId } },
      ...(sessionKey === undefined ? [] : [{ key: "sessionKey", match: { value: sessionKey } }]),
    ],
  });
  const asMessage = (p: { id: string | number; payload?: Record<string, unknown> | null }): StoredMessage =>
    ({ ...(p.payload ?? {}), id: String(p.id) }) as StoredMessage;

  return {
    ready: async () => {
      const existing = (await client.getCollections()).collections.map((c) => c.name);
      await ensure(existing, messagesCollection, ["userId", "sessionKey"], ["timestamp"]);
      await ensure(existing, titlesCollection, ["userId", "sessionKey"], []);
      await copyArchive(existing);
    },
    append: async (message) => {
      const { id, ...payload } = message;
      await client.upsert(messagesCollection, { points: [{ id, vector: PLACEHOLDER, payload }] });
    },
    messages: async (q) => {
      const result = await client.scroll(messagesCollection, {
        filter: filterOf(q.userId, q.sessionKey),
        order_by: { key: "timestamp", direction: q.order },
        limit: q.limit,
        ...(q.cursor === undefined ? {} : { offset: offsetOf(q.cursor) }),
        with_payload: true,
      });
      const next = cursorOf(result.next_page_offset);
      const messages = result.points.map(asMessage);
      return next === undefined ? { messages } : { messages, next };
    },
    recent: async (q) => {
      const result = await client.scroll(messagesCollection, {
        filter: filterOf(q.userId),
        order_by: { key: "timestamp", direction: "desc" },
        limit: q.limit,
        with_payload: true,
      });
      return result.points.map(asMessage);
    },
    setTitle: async (title) => {
      await client.upsert(titlesCollection, {
        points: [{ id: titlePointId(title.userId, title.sessionKey), vector: PLACEHOLDER, payload: { ...title } }],
      });
    },
    titles: async (q) => {
      if (q.sessionKeys.length === 0) return [];
      const result = await client.scroll(titlesCollection, {
        filter: {
          must: [
            { key: "userId", match: { value: q.userId } },
            { key: "sessionKey", match: { any: q.sessionKeys } },
          ],
        },
        limit: q.sessionKeys.length,
        with_payload: true,
      });
      return result.points.map((p) => p.payload).filter(isTitle);
    },
    health: async () => {
      try {
        await client.getCollections();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * The conversation store on Qdrant, at `QDRANT_URL`. Building it doesn't
 * reach Qdrant: a store that isn't answering yet is the core's business.
 */
export function qdrantConversations(): ConversationStorePlugin {
  return {
    apiVersion: CONVERSATION_STORE_API_VERSION,
    name: "qdrant",
    build: ({ env, log }) => createQdrantConversations(new QdrantClient({ url: env.QDRANT_URL || "http://qdrant:6333" }), env, log),
  };
}
