/**
 * Model-invocable wiki tools (`list_files`/`read_file`/`write_file`/`grep`/
 * `promote_note`/`resolve_reference`) for one person, wrapping the plain
 * functions in `identity/vault-access.ts` and `wiki-note.ts` in `tool()`, same
 * split as cli-executor.ts/cli-tool.ts for the external CLIs.
 *
 * The person sees the common area (`curated/`) and their own area as
 * `personal/`, nothing else (see `vault-access.ts`). `write_file` writes only
 * below `personal/notes/`; the common area is reached by `promote_note`, which
 * stages the copy behind the same confirmation token as any irreversible action,
 * so it lands only when the person confirms it, never on the model's say-so.
 * `writeInferredNote` is deliberately never wired into a tool here: a person's
 * `inferred/` notes are written by the deterministic consolidation engine only.
 *
 * Every `execute` returns `{ ok, ... }` instead of throwing, so a rejected or
 * invalid call is a self-correctable model turn, not a crashed tool call.
 */
import type { ExecutableTool, StageConfirmation } from "@mercury-fw/plugin-types";
import { tool } from "ai";
import { z } from "zod";
import {
  curatedDestination,
  grepVisible,
  listVisible,
  readConfirmationNote,
  readVisible,
} from "../identity/vault-access.ts";
import { writeCuratedNote, writePersonalNote } from "./wiki-note.ts";

export type WikiToolsDeps = {
  vaultPath: string;
  /** The person's user key (see `identity/user-key.ts`). */
  key: string;
  /** Stages a promotion behind a confirmation token, bound to this person and session. */
  stageConfirmation: StageConfirmation;
};

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n\n?/;

/** A note's text without its frontmatter block, so a promoted note gets the common area's own. */
function withoutFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "").replace(/\n$/, "");
}

/** Today's date as the `last_updated` a note written now carries. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Builds the wiki tools scoped to `deps.key`: the common area plus that person's own area, as `personal/`. */
export function createWikiTools(
  deps: WikiToolsDeps,
): Record<"list_files" | "read_file" | "write_file" | "grep" | "promote_note" | "resolve_reference", ExecutableTool> {
  const { vaultPath, key, stageConfirmation } = deps;
  const scope = { vaultPath, key };

  const list_files = tool({
    description:
      "List every wiki document you can see: curated/ (the team's common knowledge) and personal/, the notes kept " +
      "for the person you're talking to (personal/notes/ is what you wrote for them, personal/inferred/ what " +
      "Mercury learned about them). Nobody else's notes are ever listed.",
    inputSchema: z.object({}),
    execute: async () => {
      const files = await listVisible(scope);
      return { ok: true as const, files };
    },
  });

  const read_file = tool({
    description:
      'Read a wiki document by the path list_files and grep give, e.g. "curated/standards/jira-fields.md" or ' +
      '"personal/notes/plan.md". Only curated/ and personal/ are readable.',
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path }) => {
      try {
        const content = await readVisible(scope, path);
        return { ok: true as const, content };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const write_file = tool({
    description:
      'Write or update a note for the person you\'re talking to, under personal/notes/ (e.g. "personal/notes/plan.md"). ' +
      "Only they can see it. curated/ can't be written here: to share a note with the team, use promote_note.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    execute: async ({ path, content }) => {
      try {
        await writePersonalNote(vaultPath, key, path, { last_updated: today() }, content);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const grep = tool({
    description:
      "Search the wiki documents you can see (curated/ and personal/) for a regular expression pattern, ignoring case. " +
      "Returns matching lines with their file path and line number.",
    inputSchema: z.object({ pattern: z.string().min(1) }),
    execute: async ({ pattern }) => {
      try {
        const matches = await grepVisible(scope, pattern);
        return { ok: true as const, matches };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  const promote_note = tool({
    description:
      'Share one of the person\'s notes with the whole team: copies "from" (a path under personal/notes/) to "to" in ' +
      'curated/ (e.g. "standards/release.md"). It only happens once the person explicitly confirms it, so use it ' +
      "only when they asked to share the note.",
    inputSchema: z.object({ from: z.string().min(1), to: z.string() }),
    execute: async ({ from, to }) => {
      try {
        if (!from.startsWith("personal/notes/")) throw new Error(`only a note under personal/notes/ can be promoted: ${from}`);
        const body = withoutFrontmatter(await readVisible(scope, from));
        const destination = curatedDestination(vaultPath, to);
        const summary = `promote ${from} to curated/${destination}`;
        const token = await stageConfirmation({
          describe: summary,
          run: async () => {
            await writeCuratedNote(vaultPath, destination, { last_updated: today() }, body);
            return { ok: true, data: { promoted: `curated/${destination}` } };
          },
        });
        return {
          ok: false as const,
          pendingConfirmation: true as const,
          token,
          summary,
          error:
            "Sharing a note with the team requires explicit confirmation before it happens. Tell the user it's staged " +
            "and awaiting their confirmation. Never mention the token value in your reply, in any form — do not tell " +
            "them how to confirm it, the channel handles that on its own.",
        };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  // Reaches the person's confirmations/ folder by exact token only: it's
  // invisible to list_files/read_file/grep (see ConfirmationFrontmatterSchema's
  // doc comment), and scoped to their own area, so a token string that
  // happens to match someone else's is still unreachable.
  const resolve_reference = tool({
    description:
      "Resolve an opaque [REQ:<token>] reference (e.g. one you see in your own context) into the confirmation " +
      "request it points to — a past action that required explicit confirmation, and whether it was confirmed, " +
      "failed, or is still pending. If it's still pending, ask the user whether they still want it done — never " +
      "re-run the command yourself without them explicitly saying so.",
    inputSchema: z.object({ token: z.string().min(1) }),
    execute: async ({ token }) => {
      try {
        const content = await readConfirmationNote(vaultPath, key, token);
        return { ok: true as const, content };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });

  return { list_files, read_file, write_file, grep, promote_note, resolve_reference };
}
