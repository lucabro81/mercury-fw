/**
 * The memory-provider seam (issue #4, built ahead of the broader #30
 * design): a memory mechanism that hooks the turn — capturing the
 * exchange after it happens, and contributing its own recall tools — kept
 * behind a small interface so the composition root wires it like any
 * other provider rather than hardwiring it into the pipeline. Only the two
 * hooks #4 exercises live here; the wider generalization (priming,
 * summarizer, wiki strategy as swappable providers) is deferred to #30.
 *
 * The one implementation today is the verbatim archive
 * (`./verbatim-archive-store.ts`).
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { appendVerbatimMessage, searchVerbatim, shownText } from "./verbatim-archive-store.ts";
import type { QdrantClientLike } from "./episodic-store.ts";

/**
 * One side of an exchange to archive — the provider stamps its own durable
 * timestamp. `displays` are what the turn showed after the answer, if anything.
 */
export type VerbatimExchange = {
  userId: string;
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  displays?: string[];
};

/** Per-turn identity a provider's recall tools are scoped to. `userId` is what makes recall cross-session. */
export type MemoryProviderContext = {
  sessionKey: string;
  userId: string;
};

/**
 * A memory mechanism the composition root can wire in. `captureExchange`
 * runs after a turn resolves (post-message); `sessionTools` contributes
 * model-invocable recall for the calling session. Both optional — a
 * provider may only capture, or only recall.
 */
export type MemoryProvider = {
  captureExchange?(exchange: VerbatimExchange): Promise<void>;
  sessionTools?(ctx: MemoryProviderContext): Record<string, Tool>;
};

export type VerbatimArchiveProviderDeps = {
  client: QdrantClientLike;
  collectionName: string;
  embed: (text: string) => Promise<number[]>;
  /** Test seam; defaults to `() => new Date()`. The provider owns the durable ordering timestamp. */
  now?: () => Date;
};

const RECALL_DEFAULT_LIMIT = 5;
const RECALL_MAX_LIMIT = 20;

/**
 * Builds the verbatim-archive provider: captures every user/assistant
 * message verbatim to its Qdrant collection, and exposes a
 * `recall_verbatim` tool that similarity-searches that archive scoped to
 * the calling user — letting a later session resurface what was actually
 * said before, beyond the live history window.
 */
export function createVerbatimArchiveProvider(deps: VerbatimArchiveProviderDeps): MemoryProvider {
  const now = deps.now ?? (() => new Date());
  return {
    captureExchange: async (exchange) => {
      // An empty/whitespace-only message (e.g. a present()-only turn with no
      // prose) has nothing to archive — skip it rather than store a
      // meaningless point and embed an empty string.
      if (shownText(exchange.content, exchange.displays).trim() === "") {
        return;
      }
      await appendVerbatimMessage(deps.client, deps.collectionName, deps.embed, {
        ...exchange,
        timestamp: now().toISOString(),
      });
    },
    sessionTools: (ctx) => {
      const recall_verbatim = tool({
        description:
          "Search the durable verbatim archive of what you and this user actually said in earlier " +
          "conversations, beyond the current history window — e.g. 'what did we say about KAN-1 last week'. " +
          "Returns real past messages with their timestamps; quote them, don't reconstruct from memory.",
        inputSchema: z.object({
          query: z.string().min(1),
          limit: z.number().int().positive().max(RECALL_MAX_LIMIT).optional(),
        }),
        execute: async ({ query, limit }) => {
          const messages = await searchVerbatim(deps.client, deps.collectionName, deps.embed, {
            userId: ctx.userId,
            queryText: query,
            limit: limit ?? RECALL_DEFAULT_LIMIT,
          });
          return { ok: true as const, messages };
        },
      });
      return { recall_verbatim };
    },
  };
}
