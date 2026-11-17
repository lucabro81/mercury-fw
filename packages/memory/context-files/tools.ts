/**
 * The tools the model reads a session's files with: `read_context_file`,
 * a file's lines in pieces, and `search_context_files`, a text across the
 * files or in one. Both work on the files of the turn's own session, which
 * the core hands the plugin: the model only names a file of it.
 *
 * Used by: `index.ts`, for every turn's tools.
 */
import type { ExecutableTool } from "@mercury-fw/plugin-types";
import { tool } from "ai";
import { z } from "zod";
import { MAX_MATCHES, MAX_READ_LINES, type SessionFiles } from "./session-files.ts";

/** The two tools on `files`, the files of the turn's session. */
export function createContextFileTools(files: SessionFiles): { read_context_file: ExecutableTool; search_context_files: ExecutableTool } {
  const read_context_file = tool({
    description:
      `Read a file of this conversation (a ref such as outputs/3, history/1 or layers/2, from the list in front of the message), ` +
      `its lines numbered, ${MAX_READ_LINES} at most per call: give from and to for a range, and go on from "next" when the answer has one.`,
    inputSchema: z.object({
      ref: z.string(),
      from: z.number().int().min(1).optional(),
      to: z.number().int().min(1).optional(),
    }),
    execute: ({ ref, from, to }) => files.read(ref, from, to),
  });
  const search_context_files = tool({
    description:
      `Find the lines holding a text (case-insensitive, not a pattern) in this conversation's files, or in one of them (ref), ` +
      `as ref:line: text, ${MAX_MATCHES} at most; then read around a match with read_context_file.`,
    inputSchema: z.object({
      text: z.string().min(1),
      ref: z.string().optional(),
    }),
    execute: ({ text, ref }) => files.search(text, ref),
  });
  return { read_context_file, search_context_files };
}
