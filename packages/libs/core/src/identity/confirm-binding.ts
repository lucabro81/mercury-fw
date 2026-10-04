/**
 * The confirmation capability a channel gets (`ctx.confirm`,
 * `ctx.resolveConfirmation`), bound to this instance's store, vault and note
 * writer. The channel passes the caller's principal and the core turns it into
 * the user key, the same one the turn runner hands staging: a token resolves
 * only for whoever staged it, and its note is the one they staged.
 */
import type { ChannelRuntimeContext } from "@mercury-fw/channel-types";
import { resolveConfirmation, tryConfirm, type ConfirmDeps } from "@mercury-fw/confirm-engine";
import { userKey } from "./user-key.ts";

/** `confirm` and `resolveConfirmation` over `deps`, each resolving as the caller's user key. */
export function bindConfirm(
  deps: Omit<ConfirmDeps, "owner">,
): Required<Pick<ChannelRuntimeContext, "confirm" | "resolveConfirmation">> {
  return {
    confirm: (token, sessionKey, principal) => tryConfirm(token, sessionKey, { ...deps, owner: userKey(principal) }),
    resolveConfirmation: (token, sessionKey, principal) =>
      resolveConfirmation(token, sessionKey, { ...deps, owner: userKey(principal) }),
  };
}
