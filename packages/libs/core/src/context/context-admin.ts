/**
 * The instance's context for the channels' admin areas (#387): who may read
 * and change it. Only people holding the `mercury.context-admin` role, given
 * by the directory like `mercury.act-as-self`, and the operator; each request
 * is for the person the core identifies the caller as (the owner, when
 * accounts are linked), and refused for anyone it doesn't admit.
 *
 * Used by: `compose.ts`, which hands it to the channels as `contextAdmin`
 * when the instance declares a `context`.
 */
import type { ChannelContextAdmin, ContextAdminOutcome, Principal } from "@mercury-fw/channel-types";
import type { People } from "../identity/people.ts";
import type { ContextSettings } from "./context-settings.ts";

/** The role that lets a person read and change the instance's context. */
export const CONTEXT_ADMIN = "mercury.context-admin";

/** Builds the channels' `contextAdmin` over `settings`; see the module comment. */
export function createChannelContextAdmin(deps: { identify: People["identify"]; settings: ContextSettings }): ChannelContextAdmin {
  /** Runs `act` with the key of the person `principal` is, when they may; refused as forbidden otherwise. */
  async function allowed<T>(principal: Principal, act: (key: string) => ContextAdminOutcome<T>): Promise<ContextAdminOutcome<T>> {
    const identified = await deps.identify(principal);
    if (!identified.ok) return { ok: false, status: "forbidden", error: identified.message };
    if (!identified.operator && !identified.person.roles.includes(CONTEXT_ADMIN)) {
      return { ok: false, status: "forbidden", error: `changing the context needs the role ${CONTEXT_ADMIN}` };
    }
    return act(identified.person.key);
  }

  return {
    read: (principal) => allowed(principal, () => ({ ok: true, value: deps.settings.view() })),
    update: (principal, profile, change) => allowed(principal, (key) => deps.settings.update(key, profile, change)),
    changes: (principal, limit) => allowed(principal, () => ({ ok: true, value: deps.settings.changes(limit) })),
  };
}
