/**
 * `recall_tool_calls`: what the model ran earlier in this conversation, as it
 * ran it. The window keeps a turn's tool calls reduced (what each ran and how
 * it went), never what they returned: asked what a call gave back, the model
 * would otherwise rebuild a plausible answer instead of quoting the real one.
 * It reads the core's tool log (`ctx.toolLog`), for the person the turn is
 * for and this session only.
 */
import type { ExecutableTool, ToolLog } from "@mercury-fw/plugin-types";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** What the prompt tells the model about the tool. Model-facing, so in English. */
export const RECALL_PROMPT_FRAGMENT = [
  "You have access to the recall_tool_calls tool.",
  "DO:",
  "- If asked what you actually ran/queried/did earlier in this same conversation, call recall_tool_calls and quote it verbatim — your earlier turns show which tools you called and how they went, but not what they returned, so reconstructing from memory instead of calling this tool risks getting it wrong.",
].join("\n");

/** The tool for one turn: `person`'s calls on `sessionKey`, newest first. */
export function createRecallToolCalls(deps: { toolLog: ToolLog; sessionKey: string; person: string }): { recall_tool_calls: ExecutableTool } {
  const recall_tool_calls = tool({
    description:
      "Recall the tool calls (name, input, output) you actually made earlier in THIS conversation, most " +
      "recent first. Use this whenever asked what you ran/queried/did — quote it verbatim, don't reconstruct " +
      "from memory.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    }),
    execute: async ({ limit }) => {
      const entries = deps.toolLog.read({ person: deps.person, sessionKey: deps.sessionKey }).slice().reverse().slice(0, limit ?? DEFAULT_LIMIT);
      return { ok: true as const, entries };
    },
  });
  return { recall_tool_calls };
}
