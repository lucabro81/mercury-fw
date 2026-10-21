/**
 * The person's own settings, for a channel that shows a settings area (the
 * HTTP surface): the same profile writes the model makes when the person
 * tells it (`profile-tools.ts`), without the model in between. Each one is
 * for the person the core identifies the caller as (the owner, when accounts
 * are linked), and refused for anyone it doesn't admit.
 */
import type { ChannelSettings } from "@mercury-fw/channel-types";
import type { People } from "./people.ts";

export function createChannelSettings(deps: {
  identify: People["identify"];
  /** Saves the time zone of the person with `key` (`ProfileStore.setTimeZone`): throws on what isn't a zone. */
  setTimeZone: (key: string, timeZone: string) => string;
}): ChannelSettings {
  return {
    setTimeZone: async (principal, timeZone) => {
      const identified = await deps.identify(principal);
      if (!identified.ok) return { ok: false, error: identified.message };
      try {
        return { ok: true, value: deps.setTimeZone(identified.person.key, timeZone) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
