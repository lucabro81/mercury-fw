/**
 * The model's way to save how the person it's talking to wants to be called
 * (see `profiles.ts`): it writes only for the turn's person, and only that
 * setting. Same `tool()`-wrapping split as `wiki-tools.ts`.
 */
import { tool } from "ai";
import { z } from "zod";
import type { ExecutableTool } from "@mercury-fw/plugin-types";
import type { ProfileStore } from "./profiles.ts";

export function createProfileTools(deps: { store: ProfileStore; key: string }): { set_preferred_name: ExecutableTool } {
  const set_preferred_name = tool({
    description:
      "Save how the person you're talking to wants to be called, whenever they tell you (\"call me Luca\") or answer when you ask. " +
      "From then on it's in your instructions, in every conversation with them.",
    inputSchema: z.object({
      name: z.string().describe("The name, exactly as they want to be called."),
    }),
    execute: async ({ name }) => {
      try {
        return { ok: true as const, name: deps.store.setName(deps.key, name) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  return { set_preferred_name };
}
