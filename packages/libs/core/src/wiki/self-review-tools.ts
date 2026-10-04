/**
 * The nightly self-review job's own tool set — distinct from
 * `wiki-tools.ts` (the model-invocable tools a normal conversation gets),
 * same reasoning already applied to `writeInferredNote` never being
 * wired into those: this is a separate trust context (a stateless admin
 * batch job, not a live conversation), scoped via `selfReviewRoots`
 * (curated/ + raw/, never inferred/ — reserved for deterministic,
 * mechanically-written notes, not an LLM's own judgment call) and with
 * capabilities no conversational tool
 * has (deleting an entry, updating/removing an index.md entry — the
 * model supplies a doc path and a description, never the file's raw text,
 * so an update can't get the `[[wikilink]]` format wrong).
 *
 * All three nightly sub-passes (`self-review-runner.ts`) share this
 * exact tool set — they differ only in system prompt and pre-computed
 * input data, not in which tools they can call.
 */
import type { ExecutableTool } from "@mercury-fw/plugin-types";
import { tool } from "ai";
import { z } from "zod";
import { listWikiFilesInRoots, readWikiFileInRoots, grepWikiInRoots, selfReviewRoots } from "./wiki-read.ts";
import { writeCuratedNote, updateIndexFile, deleteRawEntry, deleteCuratedEntry, relativeToCurated } from "./wiki-note.ts";
import { normalizeIndexKey, upsertIndexEntry, removeIndexEntry } from "./index-entry.ts";

export type SelfReviewToolsDeps = { vaultPath: string };

export function createSelfReviewTools(
  deps: SelfReviewToolsDeps,
): Record<
  | "list_files"
  | "read_file"
  | "grep"
  | "write_curated"
  | "update_index_entry"
  | "remove_index_entry"
  | "delete_raw"
  | "delete_curated",
  ExecutableTool
> {
  const { vaultPath } = deps;
  const roots = selfReviewRoots(vaultPath);

  const list_files = tool({
    description: "List every file under curated/ and raw/ (never inferred/). Returns paths relative to the vault root.",
    inputSchema: z.object({}),
    execute: async () => {
      const files = await listWikiFilesInRoots(vaultPath, roots);
      return { ok: true as const, files };
    },
  });

  const read_file = tool({
    description: 'Read a file by path, e.g. "curated/standards/x.md" or "raw/notes/y.md". Only curated/ and raw/ are readable.',
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path }) => {
      try {
        const content = await readWikiFileInRoots(vaultPath, roots, path);
        return { ok: true as const, content };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const grep = tool({
    description: "Search curated/ and raw/ files for a regular expression pattern. Returns matching lines with their file path and line number.",
    inputSchema: z.object({ pattern: z.string().min(1) }),
    execute: async ({ pattern }) => {
      try {
        const matches = await grepWikiInRoots(vaultPath, roots, pattern);
        return { ok: true as const, matches };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const write_curated = tool({
    description:
      'Create or overwrite a curated doc. "path" is relative to curated/, e.g. "standards/jira-fields.md"; the path list_files and grep give ("curated/standards/jira-fields.md") works too.',
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    execute: async ({ path, content }) => {
      try {
        await writeCuratedNote(vaultPath, relativeToCurated(path), {}, content);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const update_index_entry = tool({
    description:
      'Add or update index.md\'s line for one curated doc — pass its path in any form ("curated/projects/x.md", "projects/x.md", or "projects/x", all normalize the same way) and a short description. Writes it as a [[wikilink]] so the orphan check recognizes it; never hand-write index.md yourself, it has to match this exact format to count.',
    inputSchema: z.object({ path: z.string().min(1), description: z.string().min(1) }),
    execute: async ({ path, description }) => {
      const key = normalizeIndexKey(path);
      const curatedPath = `curated/${key}.md`;
      try {
        await readWikiFileInRoots(vaultPath, roots, curatedPath);
      } catch {
        return { ok: false as const, error: `${curatedPath} does not exist — create it first with write_curated` };
      }
      try {
        await updateIndexFile(vaultPath, (current) => upsertIndexEntry(current, key, description));
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const remove_index_entry = tool({
    description:
      'Remove index.md\'s line for one curated doc (e.g. after delete_curated) — same path forms as update_index_entry. A no-op if it has no line.',
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path }) => {
      const key = normalizeIndexKey(path);
      try {
        await updateIndexFile(vaultPath, (current) => removeIndexEntry(current, key));
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const delete_raw = tool({
    description: 'Delete a raw/ entry once it has been triaged (merged, promoted, or discarded). "path" must start with "raw/".',
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path }) => {
      if (!path.startsWith("raw/")) {
        return { ok: false as const, error: `path must start with "raw/" (got "${path}")` };
      }
      try {
        await deleteRawEntry(vaultPath, path.slice("raw/".length));
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const delete_curated = tool({
    description: 'Delete a curated doc that is redundant or superseded. "path" must start with "curated/". Remove its index.md line too, if it has one.',
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path }) => {
      if (!path.startsWith("curated/")) {
        return { ok: false as const, error: `path must start with "curated/" (got "${path}")` };
      }
      try {
        await deleteCuratedEntry(vaultPath, path.slice("curated/".length));
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  return { list_files, read_file, grep, write_curated, update_index_entry, remove_index_entry, delete_raw, delete_curated };
}
