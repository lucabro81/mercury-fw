/**
 * Model-invocable recall of this conversation's own past tool calls —
 * same split as `wiki-tools.ts` wrapping plain functions in `tool()`.
 * Exists because `SessionHistory` (`history.ts`) only ever persists the
 * final assistant text of a turn, never the tool-call trace: asked to
 * recall exactly what it ran, the model otherwise has no ground truth in
 * its own context and reconstructs a plausible-looking (and sometimes
 * wrong) answer instead of quoting the real one. Backed by
 * `tool-log-buffer.ts`, filtered to the calling person and session only —
 * never another conversation's history.
 */
import type { ExecutableTool } from "@mercury-fw/plugin-types";
import { tool } from "ai";
import { z } from "zod";
import { getToolLog } from "./tool-log-buffer.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export type ToolLogRecallDeps = {
  sessionKey: string;
  /** The user key of the person the turn is for. */
  owner: string;
};

export function createToolLogRecallTool(deps: ToolLogRecallDeps): { recall_tool_calls: ExecutableTool } {
  const recall_tool_calls = tool({
    description:
      "Recall the tool calls (name, input, output) you actually made earlier in THIS conversation, most " +
      "recent first. Use this whenever asked what you ran/queried/did — quote it verbatim, don't reconstruct " +
      "from memory.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    }),
    execute: async ({ limit }) => {
      const entries = getToolLog({ owner: deps.owner, sessionKey: deps.sessionKey }).slice(0, limit ?? DEFAULT_LIMIT);
      return { ok: true as const, entries };
    },
  });

  return { recall_tool_calls };
}
