/**
 * The confirmation capability a channel gets (`ctx.confirm`,
 * `ctx.resolveConfirmation`), bound to this instance's store, vault and note
 * writer. The channel passes the caller's principal and the core identifies
 * the person, the same way the turn runner does before staging: a token
 * resolves only for whoever staged it, and its note is the one they staged.
 * Someone the core won't talk to confirms nothing. Text that isn't a token is
 * left to the turn without asking who sent it.
 */
import type { ChannelRuntimeContext } from "@mercury-fw/channel-types";
import { isTokenShaped, resolveConfirmation, tryConfirm, type ConfirmDeps } from "@mercury-fw/confirm-engine";
import { createPeople, type People } from "./people.ts";

/** `confirm` and `resolveConfirmation` over `deps`, each resolving as the person `identify` says the caller is. */
export function bindConfirm(
  deps: Omit<ConfirmDeps, "owner">,
  identify: People["identify"] = createPeople({ directory: "none" }).identify,
): Required<Pick<ChannelRuntimeContext, "confirm" | "resolveConfirmation">> {
  return {
    confirm: async (token, sessionKey, principal) => {
      if (!isTokenShaped(token.trim())) return null;
      const identified = await identify(principal);
      if (!identified.ok) return identified.message;
      return tryConfirm(token, sessionKey, { ...deps, owner: identified.person.key });
    },
    resolveConfirmation: async (token, sessionKey, principal) => {
      if (!isTokenShaped(token.trim())) return { status: "not-a-token" };
      const identified = await identify(principal);
      if (!identified.ok) return { status: "not-found" };
      return resolveConfirmation(token, sessionKey, { ...deps, owner: identified.person.key });
    },
  };
}
