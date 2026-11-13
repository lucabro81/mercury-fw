/**
 * `@mercury-fw/corrections`: what the agent learns about using a tool. When a
 * command fails and a later one for the same binary works in the same turn,
 * the background model describes the correction (`extractor.ts`), it's kept
 * in the vector index's `tool_corrections` space (`store.ts`), and the wiki
 * it's given promotes the one with most support to
 * `curated/standards/<tool>-<topic>.md`, which everyone reads.
 */
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import type { WikiNotes } from "@mercury-fw/wiki";
import { createToolCorrectionExtractor, hasCorrectionCandidates } from "./extractor.ts";
import { ensureToolCorrectionsSpace, searchToolCorrectionsByTopic, storeToolCorrection } from "./store.ts";

export type CorrectionsOptions = {
  /** The wiki the corrections are promoted into (`wiki()`, declared in `plugins` too). */
  wiki: { notes: Pick<WikiNotes, "promoteCorrection"> };
};

/** The corrections plugin (see the module comment). */
export function corrections(options: CorrectionsOptions): Plugin {
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "corrections",
    description: "Learns how to use a tool from a command that failed and the one that worked, and writes it down in the wiki.",
    actsAs: "anyone",
    needs: ["vectorIndex", "embedding"],
    build: (ctx) => {
      const index = ctx.vectorIndex;
      const embed = ctx.embed;
      if (index === undefined || embed === undefined) throw new Error("corrections: no vector index or embedding model (needs: vectorIndex, embedding)");
      const extract = createToolCorrectionExtractor(ctx.backgroundModel ?? ctx.model, undefined, { log: ctx.log });
      const job = ctx.job ?? (<T,>(_name: string, _urgency: string, fn: () => Promise<T>) => fn());
      // The space is made once its vectors' length is known, at the first correction; again after a failure.
      let space: Promise<void> | undefined;
      const ready = () =>
        (space ??= embed("dimensions")
          .then((vector) => ensureToolCorrectionsSpace(index, vector.length))
          .catch((err: unknown) => {
            space = undefined;
            throw err;
          }));

      return {
        afterTurn: async (turn) => {
          if (!hasCorrectionCandidates(turn.calls)) return;
          await job("correction", "soon", async () => {
            for (const correction of await extract(turn.calls)) {
              // Each correction on its own: one the index or the wiki can't take never costs the others.
              try {
                await ready();
                await storeToolCorrection(index, embed, { ...correction, timestamp: new Date().toISOString() });
              } catch (err) {
                ctx.log(`[corrections] ${correction.tool}/${correction.topic}: not kept: ${err instanceof Error ? err.message : String(err)}`);
                continue;
              }
              try {
                const decision = await options.wiki.notes.promoteCorrection(correction.tool, correction.topic, (limit) =>
                  searchToolCorrectionsByTopic(index, embed, { tool: correction.tool, topic: correction.topic, limit }),
                );
                ctx.log(`[corrections] ${correction.tool}/${correction.topic}: ${decision}`);
              } catch (err) {
                ctx.log(`[corrections] ${correction.tool}/${correction.topic}: kept, not promoted: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          });
        },
      };
    },
  };
}
