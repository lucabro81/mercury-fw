/**
 * `@mercury-fw/profile`: lets the model save what a person tells it about
 * themselves, in the core's profiles (`ctx.profiles`): how they want to be
 * called (`set_preferred_name`), the time zone they're in (`set_time_zone`),
 * the language they want (`set_preferred_language`, when the instance ships
 * more than one). The core reads them back on every turn (the name in the
 * prompt, the language of its texts, the stamp on each message), and the
 * channels with it.
 */
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { createProfileTools } from "./profile-tools.ts";

/** What the model reads about the person's name, in the system prompt. */
export const PROFILE_PROMPT_FRAGMENT = [
  "You have access to the set_preferred_name tool.",
  "DO:",
  "- When the person tells you how they want to be called, now or in any later conversation, save it with set_preferred_name.",
].join("\n");

/** The profile plugin (see the module comment). */
export function profile(): Plugin {
  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "profile",
    description: "Remembers how each person wants to be called, their time zone and their language.",
    actsAs: "anyone",
    systemPromptFragment: PROFILE_PROMPT_FRAGMENT,
    build: (ctx) => {
      const profiles = ctx.profiles;
      if (profiles === undefined) throw new Error("profile: this core keeps no profiles (ctx.profiles)");
      return {
        sessionTools: (session) => (session.person === null ? {} : createProfileTools({ profiles, key: session.person.key })),
      };
    },
  };
}
