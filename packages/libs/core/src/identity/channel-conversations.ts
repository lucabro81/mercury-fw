/**
 * The person's own conversations, for a channel that lists them (the HTTP
 * surface): renaming one (#214), the title the person chose in place of the
 * one Mercury generated. For the person the core identifies the caller as
 * (the owner, when accounts are linked), only for a conversation of theirs
 * in the archive, and refused for anyone the core doesn't admit.
 */
import type { ChannelConversations } from "@mercury-fw/channel-types";
import { titleError } from "../memory/conversation-titles-store.ts";
import type { People } from "./people.ts";

export function createChannelConversations(deps: {
  identify: People["identify"];
  /** Whether the person with `key` has the conversation `sessionKey` in the archive. */
  owns: (key: string, sessionKey: string) => Promise<boolean>;
  /** Saves `title` as the person's own title of `sessionKey`. */
  setTitle: (key: string, sessionKey: string, title: string) => Promise<void>;
}): ChannelConversations {
  return {
    rename: async (principal, sessionKey, title) => {
      const identified = await deps.identify(principal);
      if (!identified.ok) return { ok: false, error: identified.message };
      const trimmed = title.trim();
      const error = titleError(trimmed);
      if (error !== undefined) return { ok: false, error };
      if (!(await deps.owns(identified.person.key, sessionKey))) return { ok: false, error: "no such conversation", notFound: true };
      await deps.setTitle(identified.person.key, sessionKey, trimmed);
      return { ok: true, title: trimmed };
    },
  };
}
