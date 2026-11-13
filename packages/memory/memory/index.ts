/**
 * `@mercury-fw/memory`: what the agent remembers of its conversations with
 * each person, in the app's vector index.
 *
 * - Episodes: every few messages a person writes in a conversation, and when
 *   the conversation closes, the background model summarizes what was said,
 *   asked and decided (`episodic_memory`), and finds the standing facts about
 *   the person in it (`semantic_facts`), which the wiki it's given promotes to
 *   their `inferred/` notes (`capture.ts`).
 * - A `session` context layer: a new conversation starts with the last one's
 *   summaries and the facts it reinforced, as background.
 * - `recall_verbatim`: every message a turn leaves, indexed (`verbatim_archive`)
 *   and searched by meaning (`recall.ts`).
 * - `summariesOf`, what `conversationWindow({ earlier })` reads of a reopened
 *   conversation's older part.
 *
 * Nothing of the operator's (the terminal) is remembered. The spaces are made
 * at first use, as long as the embedding model's vectors; an index from before
 * the user key has its ids moved onto it then (`migrate.ts`).
 */
import { formatTurnStamp, PLUGIN_API_VERSION, type Plugin, type VectorIndex } from "@mercury-fw/plugin-types";
import type { WikiNotes } from "@mercury-fw/wiki";
import { captureToMemory, createSessionBuffers } from "./capture.ts";
import { createEpisodicSummarizer } from "./episodic-summarizer.ts";
import {
  ensureEpisodicSpace,
  EPISODIC_SPACE,
  getEpisodicSummariesBySession,
  getLastSessionEpisodicSummaries,
  storeEpisodicSummary,
} from "./episodic-store.ts";
import type { Message } from "./messages.ts";
import { migrateMemoryToUserKeys } from "./migrate.ts";
import { createVerbatimRecall } from "./recall.ts";
import { createSemanticFactExtractor } from "./semantic-fact-extractor.ts";
import { ensureSemanticFactsSpace, searchSemanticFactsByTopic, SEMANTIC_FACTS_SPACE, storeSemanticFact } from "./semantic-facts-store.ts";
import { ensureVerbatimSpace, VERBATIM_SPACE } from "./verbatim-index.ts";

export type MemoryOptions = {
  /** The wiki the facts are promoted into, and read back from for the recap (`wiki()`, declared in `plugins` too); without one the facts stay in the index. */
  wiki?: { notes: Pick<WikiNotes, "promoteFact" | "facts"> };
  /** How many new messages of a person in a conversation make a capture: `SESSION_CAPTURE_MESSAGE_THRESHOLD`, else 6, when absent. */
  captureEvery?: number;
};

/** The memory as a plugin, with what `conversationWindow({ earlier })` reads. */
export type MemoryPlugin = Plugin & {
  /** The summaries of the person's conversation `sessionKey`, oldest first; none before the plugin is built. */
  summariesOf: (q: { person: string; sessionKey: string }) => Promise<Array<{ summary: string; timestamp: string }>>;
};

/** What the model reads about `recall_verbatim`, in the system prompt. */
export const MEMORY_PROMPT_FRAGMENT = [
  "You have access to the recall_verbatim tool.",
  "DO:",
  "- If asked about something said in an EARLIER conversation — beyond what you can see in this one — call recall_verbatim to retrieve the actual past messages and quote them, don't reconstruct from memory. This searches a durable archive of what you and this person really said before.",
  "- Use it only for what was said in past conversations, never for what you ran in the CURRENT one.",
].join("\n");

/** How the recap opens: background, never the assistant's own words, maybe out of date. */
export const RECAP_INTRO = "Background from your earlier conversations with this person, for reference only (it may be out of date):";

/** How the recap closes. */
const RECAP_OUTRO = "Don't bring it up unless the person refers to it, never present it as current, and read any data from a service again with its tool.";

const DEFAULT_CAPTURE_EVERY = 6;

/** The memory plugin (see the module comment). */
export function memory(options: MemoryOptions = {}): MemoryPlugin {
  let built: { index: VectorIndex } | undefined;
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "memory",
    description: "Remembers what was said in earlier conversations with each person, and what they're like, and finds past messages again.",
    actsAs: "anyone",
    needs: ["vectorIndex", "embedding"],
    systemPromptFragment: MEMORY_PROMPT_FRAGMENT,
    summariesOf: async ({ person, sessionKey }) =>
      built === undefined
        ? []
        : (await getEpisodicSummariesBySession(built.index, { userId: person, sessionKey })).map(({ summary, timestamp }) => ({ summary, timestamp })),
    build: (ctx) => {
      const index = ctx.vectorIndex;
      const embed = ctx.embed;
      if (index === undefined || embed === undefined) throw new Error("memory: no vector index or embedding model (needs: vectorIndex, embedding)");
      built = { index };
      const model = ctx.backgroundModel ?? ctx.model;
      const job = ctx.job ?? (<T,>(_name: string, _urgency: string, fn: () => Promise<T>) => fn());
      const wiki = options.wiki;

      // The spaces are made once their vectors' length is known, at first use;
      // again after a failure. Then the ids from before the user key move.
      let spaces: Promise<void> | undefined;
      const ready = () =>
        (spaces ??= (async () => {
          const dimensions = (await embed("dimensions")).length;
          if (dimensions === 0) throw new Error("the embedding model returned an empty vector");
          await ensureEpisodicSpace(index, dimensions);
          await ensureSemanticFactsSpace(index, dimensions);
          await ensureVerbatimSpace(index, dimensions);
          await migrateMemoryToUserKeys(index, [EPISODIC_SPACE, SEMANTIC_FACTS_SPACE, VERBATIM_SPACE], (msg) => ctx.log(`[memory] ${msg}`));
        })().catch((err: unknown) => {
          spaces = undefined;
          throw err;
        }));

      const summarize = createEpisodicSummarizer(model);
      const extractFacts = createSemanticFactExtractor(model);
      const threshold = options.captureEvery ?? (Number(ctx.env.SESSION_CAPTURE_MESSAGE_THRESHOLD) || DEFAULT_CAPTURE_EVERY);
      const buffers = createSessionBuffers({
        threshold,
        job: (fn) => job("capture", "idle", fn),
        log: ctx.log,
        capture: async (person, sessionKey, messages) => {
          await ready();
          await captureToMemory(person, sessionKey, messages, {
            summarize,
            storeSummary: (entry) => storeEpisodicSummary(index, embed, entry),
            extractFacts,
            storeFact: (entry) => storeSemanticFact(index, embed, entry),
            ...(wiki === undefined
              ? {}
              : {
                  promoteFact: (userId: string, topic: string) =>
                    wiki.notes.promoteFact(userId, topic, (limit) => searchSemanticFactsByTopic(index, embed, { userId, topic, limit })),
                }),
            log: ctx.log,
          });
        },
      });

      const recall = createVerbatimRecall({
        index,
        embed,
        ready,
        indexInBackground: (work) =>
          void job("archive-index", "soon", work).catch((err: unknown) =>
            ctx.log(`[memory] a message wasn't indexed: ${err instanceof Error ? err.message : String(err)}`),
          ),
      });

      /** The person's message as the core gave it to the model: after when and where it was written. */
      const stamped = (person: string, text: string): string => {
        const timeZone = ctx.profiles?.timeZoneOf(person) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        return `${formatTurnStamp(new Date(), timeZone)}${text}`;
      };

      return {
        afterTurn: async (turn) => {
          if (turn.operator) return;
          const messages: Message[] = [
            ...(turn.input === "" ? [] : [{ role: "user" as const, content: stamped(turn.person.key, turn.input) }]),
            { role: "assistant" as const, content: turn.answer },
          ];
          await buffers.add(turn.sessionKey, turn.person.key, messages);
        },
        onSessionClose: (session) => buffers.close(session.sessionKey),
        onTurnRecord: (record) => recall.indexRecord(record),
        sessionTools: (sctx) => (sctx.person === null ? {} : recall.sessionTools({ sessionKey: sctx.sessionKey, userId: sctx.person.key })),
        context: {
          scope: "session",
          // A conversation its client reopens at will is a fresh start: nothing from another one comes in.
          build: async (req) => {
            if (req.reopened || req.operator) return [];
            await ready();
            const entries = await getLastSessionEpisodicSummaries(index, { userId: req.person.key });
            if (entries.length === 0) return [];
            const when = new Set(entries.map((e) => e.timestamp));
            const facts = wiki === undefined ? [] : (await wiki.notes.facts(req.person.key)).filter((f) => f.derivedFrom.some((t) => when.has(t)));
            return [
              [
                RECAP_INTRO,
                ...(facts.length === 0 ? [] : [`Known facts:\n${facts.map((f) => `- ${f.topic}: ${f.body}`).join("\n")}`]),
                `Last session:\n${entries.map((e) => `- ${e.summary}`).join("\n")}`,
                RECAP_OUTRO,
              ].join("\n"),
            ];
          },
        },
      };
    },
  };
}
