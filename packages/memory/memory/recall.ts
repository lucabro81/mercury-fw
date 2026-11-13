/**
 * The search of what was said (issue #4): every message a turn or a resolved
 * confirmation leaves (`archivedMessages`, the record the plugins hear) is
 * indexed in the vector index's `verbatim_archive` space
 * (`verbatim-index.ts`), and `recall_verbatim` searches it by meaning,
 * scoped to the person. Writing the conversation store is the archive
 * plugin's (`@mercury-fw/archive`); this only indexes, never for the
 * operator, whose turns nothing keeps.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { archivedMessages, type TurnRecord, type VectorIndex } from "@mercury-fw/plugin-types";
import { indexVerbatimMessage, searchVerbatim } from "./verbatim-index.ts";

/** Per-turn identity the recall tool is scoped to. `userId` is what makes recall cross-session. */
export type VerbatimRecallContext = {
  sessionKey: string;
  userId: string;
};

export type VerbatimRecall = {
  /** Indexes what `record` leaves, as background work when `indexInBackground` is given. */
  indexRecord(record: TurnRecord): Promise<void>;
  /** `recall_verbatim`, for the person of `ctx`. */
  sessionTools(ctx: VerbatimRecallContext): Record<string, Tool>;
};

export type VerbatimRecallDeps = {
  /** Where messages are indexed and `recall_verbatim` searches. */
  index: VectorIndex;
  embed: (text: string) => Promise<number[]>;
  /** Runs a message's indexing later, as background work (the core's queue for the model); awaited when absent. */
  indexInBackground?: (work: () => Promise<void>) => void;
  /** Gets the index's space ready, before a message is indexed or searched; nothing to wait for when absent. */
  ready?: () => Promise<void>;
};

const RECALL_DEFAULT_LIMIT = 5;
const RECALL_MAX_LIMIT = 20;

/** Builds the index of what was said and its `recall_verbatim` (see the module comment). */
export function createVerbatimRecall(deps: VerbatimRecallDeps): VerbatimRecall {
  return {
    indexRecord: async (record) => {
      if (record.operator) return;
      for (const message of archivedMessages(record)) {
        const work = async () => {
          await deps.ready?.();
          await indexVerbatimMessage(deps.index, deps.embed, message);
        };
        if (deps.indexInBackground === undefined) await work();
        else deps.indexInBackground(work);
      }
    },
    sessionTools: (ctx): Record<string, Tool> => {
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
          await deps.ready?.();
          const messages = await searchVerbatim(deps.index, deps.embed, {
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
