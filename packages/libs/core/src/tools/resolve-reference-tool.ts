/**
 * `resolve_reference`: turns an opaque `[REQ:<token>]` (the primer's "Open
 * references", or one in the conversation) into the confirmation note it
 * points to (see `data/confirmation-notes.ts`). It reaches the note by exact
 * token only, in the person's own folder, so a token that matches someone
 * else's is still unreachable. Its `execute` returns `{ ok, ... }` instead of
 * throwing, so a wrong token is a turn the model corrects itself in.
 */
import type { ExecutableTool } from "@mercury-fw/plugin-types";
import { tool } from "ai";
import { z } from "zod";
import { readConfirmationNote } from "../data/confirmation-notes.ts";

/** Builds `resolve_reference` for the person `key`, over the notes in `notesRoot`. */
export function createResolveReferenceTool(deps: { notesRoot: string; key: string }): Record<"resolve_reference", ExecutableTool> {
  const resolve_reference = tool({
    description:
      "Resolve an opaque [REQ:<token>] reference (e.g. one you see in your own context) into the confirmation " +
      "request it points to — a past action that required explicit confirmation, and whether it was confirmed, " +
      "failed, or is still pending. If it's still pending, ask the user whether they still want it done — never " +
      "re-run the command yourself without them explicitly saying so.",
    inputSchema: z.object({ token: z.string().min(1) }),
    execute: async ({ token }) => {
      try {
        const content = await readConfirmationNote(deps.notesRoot, deps.key, token);
        return { ok: true as const, content };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  });
  return { resolve_reference };
}
