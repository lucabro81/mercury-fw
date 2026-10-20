/**
 * The model's way to save how the person it's talking to wants to be called
 * and the language they want to be talked to in (see `profiles.ts`): it
 * writes only for the turn's person, and only those settings. The language
 * is one of those the instance ships, and the tool is there only when it
 * ships more than English. Same `tool()`-wrapping split as `wiki-tools.ts`.
 */
import { tool } from "ai";
import { z } from "zod";
import type { ExecutableTool } from "@mercury-fw/plugin-types";
import type { ProfileStore } from "./profiles.ts";

export function createProfileTools(deps: {
  store: ProfileStore;
  key: string;
  /** The languages the instance ships (`I18n.supported`), English when left out. */
  languages?: string[];
}): { set_preferred_name: ExecutableTool; set_preferred_language?: ExecutableTool } {
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
  const languages = deps.languages ?? ["en"];
  if (languages.length < 2) return { set_preferred_name };
  const set_preferred_language = tool({
    description:
      "Save the language the person you're talking to wants you to use, whenever they ask for one. " +
      `From then on you answer in it, in every conversation with them. The languages available: ${languages.join(", ")}.`,
    inputSchema: z.object({
      language: z.enum(languages as [string, ...string[]]).describe("The language's code."),
    }),
    execute: async ({ language }) => {
      try {
        return { ok: true as const, language: deps.store.setLanguage(deps.key, language) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  return { set_preferred_name, set_preferred_language };
}
