/**
 * Builds a turn's plugin tools from what the person is offered (see
 * `offering.ts`): each plugin's own tool factory, invoked for the person when
 * it acts as them or as no one, with no person when it acts as Mercury. Acting
 * as Mercury for someone (not the operator), the tools say so and log who
 * asked (see `act-as-self.ts`); only a tool acting as the person can start
 * their login. Every tool's output goes through the display channel (see
 * `display-channel.ts`): its display is stashed for the session, never handed
 * to the model.
 */
import type { Tool } from "ai";
import type { LoginRequired, PersonLogin, SessionToolContext } from "@mercury-fw/plugin-types";
import type { TurnWho } from "../identity/people.ts";
import type { Offering } from "./offering.ts";
import { actingAsSelf } from "./act-as-self.ts";
import { withDisplayChannel, type StashDisplay } from "../tools/display-channel.ts";

export type OfferedToolsDeps = {
  /** The session-scoped capabilities every tool gets, bound to this turn. */
  context: Omit<SessionToolContext, "person" | "requireLogin">;
  /** Starts `personKey`'s login to `service` (the core's pending logins). */
  requireLogin: (service: string, login: PersonLogin, personKey: string) => Promise<LoginRequired>;
  log: (msg: string) => void;
  /** Stashes a tool's rendered display for this turn's session (see `display-channel.ts`). */
  stashDisplay: StashDisplay;
};

/** The tools of `offering` for `who`, and whether any plugin contributed one (`present` goes with them). */
export function buildOfferedTools(offering: Offering, who: TurnWho, deps: OfferedToolsDeps): { tools: Record<string, Tool>; hasPluginTools: boolean } {
  const tools: Record<string, Tool> = {};
  let hasPluginTools = false;
  for (const entry of offering.entries) {
    const { bundle } = entry.plugin;
    if (bundle === undefined) continue;
    hasPluginTools = true;
    // A plugin acting as no one still learns whom the turn is for, to keep what's theirs.
    const person = entry.as === "person" || entry.as === "anyone" ? { key: who.person.key } : null;
    const { login } = bundle;
    const requireLogin = async (): Promise<LoginRequired> =>
      person && login && entry.as === "person"
        ? deps.requireLogin(bundle.name, login, person.key)
        : { ok: false, error: `${bundle.name} says the user isn't logged in, and it has no way to log anyone in.` };
    const built = bundle.build({ ...deps.context, person, requireLogin }, bundle.postProcess);
    const offered =
      entry.as === "mercury" && !who.operator
        ? actingAsSelf(built, { plugin: bundle.name, personKey: who.person.key, rename: entry.variant, log: deps.log })
        : built;
    Object.assign(tools, withDisplayChannel(offered, deps.stashDisplay));
  }
  return { tools, hasPluginTools };
}
