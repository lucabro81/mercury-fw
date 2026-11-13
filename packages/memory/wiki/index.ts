/**
 * `@mercury-fw/wiki`: the team's wiki as a plugin. A git-backed vault of
 * Markdown notes: `curated/` shared by everyone, read-only to the model,
 * and each person's own area (`personal/` to the model). It contributes the
 * wiki tools for each person (`list_files`, `read_file`, `grep`,
 * `write_file`, `promote_note`) with what the model reads about them, a
 * `session` context layer with the vault's `index.md`, and a nightly review
 * of the vault on the background model, at a set time (`ctx.daily`).
 *
 * The vault is `vaultPath`, else `WIKI_VAULT_PATH`; with neither, `wiki()`
 * throws and the start stops. `build()` sets the vault up (a git repository
 * with its folders) and moves notes from an older layout into each person's
 * area.
 */
import { createWikiNotes, type WikiNotes } from "./notes.ts";
import { resolve } from "node:path";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { findOrphanCuratedDocs } from "./orphan-detector.ts";
import { runReview } from "./review.ts";
import { runContradictionCheckPass, runIndexAndOrphanPass, runRawTriagePass } from "./self-review-runner.ts";
import { initVault } from "./vault-init.ts";
import { migrateVaultToUserAreas } from "./vault-layout.ts";
import { listWikiFilesInRoots, readIndexFile } from "./wiki-read.ts";
import { createWikiTools } from "./wiki-tools.ts";

export type WikiOptions = {
  /** Where the vault lives; `WIKI_VAULT_PATH` when absent. */
  vaultPath?: string;
  /** When the nightly review runs: `at` (`"HH:MM"`) in `timeZone` (the instance's when absent); `false` for none. Every day at `"03:00"` when absent. */
  review?: { at: string; timeZone?: string } | false;
};

/** When the review runs unless the instance says otherwise. */
export const DEFAULT_REVIEW_AT = "03:00";

/** The texts a person sees from the wiki, in English (the keys an instance's language files translate). */
export const WIKI_MESSAGES = {
  "wiki.status.read": "Reading the wiki…",
  "wiki.status.write": "Writing to the wiki…",
  "wiki.status.search": "Searching…",
};

/** What the model reads about the wiki tools. */
export const WIKI_PROMPT_FRAGMENT = [
  "You have access to wiki tools: list_files, read_file, grep, write_file, promote_note — your own knowledge base. " +
    "curated/ is the team's common knowledge (conventions, docs, project status), shared by everyone: you can read it, not write it. " +
    "personal/ belongs to the person you're talking to and nobody else sees it: personal/notes/ is where you write for them, " +
    "personal/inferred/ is what you learned about them, kept by a separate process.",
  "DO:",
  "- For a CLI's own syntax/flags, rely on --help first. Only check the wiki if --help doesn't cover something specific to how this team uses that tool (a convention, a naming pattern, a policy).",
  "- When a command's --select flag description is generic/shared across multiple subcommands, don't take its inline example at face value — check that command's own \"Examples\" section at the bottom of its --help output for the syntax that actually works with it.",
  "- For anything else — documentation, project status, how some tool or process is used, team conventions — consult the wiki FIRST (grep/read_file/list_files), before trying a CLI or answering from general knowledge.",
  "- If the wiki doesn't have the answer, try a live CLI query if one is relevant, before giving up.",
  "- If you still don't know after checking both, say so plainly — don't guess or invent an answer.",
  "- If you learn something worth remembering (a correction from the user, a new convention, how this team uses a tool), first grep the wiki for a note on the same topic in personal/notes/: if there is one, read it and update it with write_file; create a new, clearly-named file under personal/notes/ only when nothing covers it.",
  "- If the person asks to share one of their notes with the team, call promote_note: it copies the note into curated/ once they confirm, and it's the only way to write there.",
  "",
  "DON'T:",
  "- DON'T claim something is documented in the wiki without actually reading it via read_file/grep first.",
  "- DON'T call promote_note unless the person asked to share that note.",
  "- DON'T write_file over an existing note without reading it first — write_file replaces the whole file, it doesn't merge, so an unread overwrite silently destroys whatever was already there.",
  "- DON'T write a wiki document restating a CLI's syntax or flags — a plugin's skill and --help are the source for those, and a note written after a failed attempt ends up contradicting them.",
].join("\n");

/**
 * The wiki as a plugin, with `notes`: what the memory plugins write into it
 * and read back (see `notes.ts`), on the same vault.
 */
export type WikiPlugin = Plugin & { notes: WikiNotes };

/** The wiki as a plugin, on the vault `options.vaultPath` (else `WIKI_VAULT_PATH`). */
export function wiki(options: WikiOptions = {}): WikiPlugin {
  const vaultPath = options.vaultPath || process.env.WIKI_VAULT_PATH;
  if (!vaultPath) {
    throw new Error("wiki: no vault: pass vaultPath or set WIKI_VAULT_PATH to the folder, on a volume of its own, the wiki lives in");
  }
  const review = options.review === undefined ? { at: DEFAULT_REVIEW_AT } : options.review;

  return {
    notes: createWikiNotes(vaultPath),
    apiVersion: PLUGIN_API_VERSION,
    name: "wiki",
    description: "The team's wiki: shared notes everyone reads and each person's own, searched, read and written by the agent.",
    actsAs: "anyone",
    messages: WIKI_MESSAGES,
    systemPromptFragment: WIKI_PROMPT_FRAGMENT,
    build: async (ctx) => {
      await initVault(vaultPath);
      // A vault from before per-person areas gets its notes moved into them.
      await migrateVaultToUserAreas(vaultPath, ctx.log).catch((err: unknown) =>
        ctx.log(`layout migration failed, the wiki starts anyway: ${String(err)}`),
      );

      const model = ctx.backgroundModel ?? ctx.model;
      const job = ctx.job ?? ((_name: string, _urgency: string, fn: () => Promise<void>) => fn());
      if (review !== false) {
        ctx.daily?.("review", review, () =>
          runReview({
            listRawEntries: () => listWikiFilesInRoots(vaultPath, [resolve(vaultPath, "raw")]),
            findOrphans: () => findOrphanCuratedDocs(vaultPath),
            runRawTriage: (rawEntries) => runRawTriagePass({ vaultPath, model, rawEntries }),
            runIndexAndOrphan: (orphans) => runIndexAndOrphanPass({ vaultPath, model, orphans }),
            runContradictionCheck: () => runContradictionCheckPass({ vaultPath, model }),
            job,
            log: ctx.log,
          }),
        );
      }

      return {
        sessionTools: (sctx) =>
          sctx.person === null ? {} : createWikiTools({ vaultPath, key: sctx.person.key, stageConfirmation: sctx.stageConfirmation }),
        toolStatusDescribers: {
          list_files: (_input, t) => t("wiki.status.read"),
          read_file: (_input, t) => t("wiki.status.read"),
          grep: (_input, t) => t("wiki.status.search"),
          write_file: (_input, t) => t("wiki.status.write"),
          promote_note: (_input, t) => t("wiki.status.write"),
        },
        // The index is the same for everyone, and stable for a session.
        context: {
          scope: "session",
          build: async () => {
            const index = (await readIndexFile(vaultPath)).trim();
            return index.length === 0 ? [] : [`Wiki index:\n${index}`];
          },
        },
      };
    },
  };
}

export { CONSOLIDATION_WINDOW, type Cluster, type ConsolidationDecision, type Occurrence, type WikiFact, type WikiNotes } from "./notes.ts";
