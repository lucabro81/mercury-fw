/**
 * What other plugins write into the wiki and read back from it, on this
 * wiki's vault (`WikiPlugin.notes`): what the memory learned about a person,
 * promoted to their `inferred/` notes, and how a tool is used, promoted to
 * `curated/standards/`. The promotion is deterministic (`consolidation.ts`):
 * the plugin hands over the last occurrences of a topic, the wiki decides.
 */
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  consolidateSemanticFact,
  consolidateToolCorrection,
  DEFAULT_CONSOLIDATION_K,
  type ConsolidationDecision,
  type Occurrence,
} from "./consolidation.ts";
import { userArea } from "./user-area.ts";
import { listWikiFilesInRoots, readWikiFileInRoots } from "./wiki-read.ts";
import { writeInferredNote, writeToolCorrectionNote } from "./wiki-note.ts";

export type { ConsolidationDecision, Occurrence } from "./consolidation.ts";

/** The last `limit` occurrences of one topic, newest first: what a promotion decides on. */
export type Cluster = (limit: number) => Promise<Occurrence[]>;

/** A fact the wiki keeps about a person: its topic, the note's text, and when the occurrences it came from were found. */
export type WikiFact = { topic: string; body: string; derivedFrom: string[] };

export type WikiNotes = {
  /** Makes the dominant value among `cluster`'s occurrences the person's note on `topic`, when it has more support than the note there. */
  promoteFact: (key: string, topic: string, cluster: Cluster) => Promise<ConsolidationDecision>;
  /** The person's facts, from their `inferred/` notes. */
  facts: (key: string) => Promise<WikiFact[]>;
  /** The same as `promoteFact` for a tool's correction, in `curated/standards/<tool>-<topic>.md`, which everyone reads. */
  promoteCorrection: (tool: string, topic: string, cluster: Cluster) => Promise<ConsolidationDecision>;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

/** The notes on the vault at `vaultPath` (see the module comment). */
export function createWikiNotes(vaultPath: string): WikiNotes {
  return {
    promoteFact: (key, topic, cluster) =>
      consolidateSemanticFact(key, topic, { vaultPath, clusterFn: (_k, _t, limit) => cluster(limit), writeInferredNoteFn: writeInferredNote }),
    promoteCorrection: (tool, topic, cluster) =>
      consolidateToolCorrection(tool, topic, { vaultPath, clusterFn: (_t, _p, limit) => cluster(limit), writeNoteFn: writeToolCorrectionNote }),
    facts: async (key) => {
      const root = resolve(vaultPath, userArea(key), "inferred");
      const facts: WikiFact[] = [];
      for (const file of await listWikiFilesInRoots(vaultPath, [root])) {
        const text = await readWikiFileInRoots(vaultPath, [root], file);
        const match = FRONTMATTER_RE.exec(text);
        const frontmatter = (match ? parseYaml(match[1] as string) : {}) as { derived_from?: unknown };
        const body = (match ? text.slice(match[0].length) : text).trim();
        if (body === "") continue;
        facts.push({
          topic: file.split("/").pop()!.replace(/\.md$/, ""),
          body,
          derivedFrom: Array.isArray(frontmatter.derived_from) ? frontmatter.derived_from.map(String) : [],
        });
      }
      return facts;
    },
  };
}

/** How many of a topic's last occurrences a promotion decides on. */
export const CONSOLIDATION_WINDOW = DEFAULT_CONSOLIDATION_K;
