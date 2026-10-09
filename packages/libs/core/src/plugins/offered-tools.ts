/**
 * Builds a turn's plugin tools from what the person is offered (see
 * `offering.ts`): each plugin's own tool factory, invoked for the person when
 * it acts as them, with no person when it acts as Mercury. Acting as Mercury
 * for someone (not the operator), the tools say so and log who asked (see
 * `act-as-mercury.ts`); only a tool acting as the person can start their login.
 */
import type { Tool } from "ai";
import type { LoginRequired, PersonLogin, SessionToolContext } from "@mercury-fw/plugin-types";
import type { TurnWho } from "../identity/people.ts";
import type { Offering } from "./offering.ts";
import { actingAsMercury } from "./act-as-mercury.ts";

export type OfferedToolsDeps = {
  /** The session-scoped capabilities every tool gets, bound to this turn. */
  context: Omit<SessionToolContext, "person" | "requireLogin">;
  /** Starts `personKey`'s login to `service` (the core's pending logins). */
  requireLogin: (service: string, login: PersonLogin, personKey: string) => Promise<LoginRequired>;
  log: (msg: string) => void;
};

/** The tools of `offering` for `who`, and whether any plugin contributed one (`present` goes with them). */
export function buildOfferedTools(offering: Offering, who: TurnWho, deps: OfferedToolsDeps): { tools: Record<string, Tool>; hasCliTool: boolean } {
  const tools: Record<string, Tool> = {};
  let hasCliTool = false;
  for (const entry of offering.entries) {
    const { bundle } = entry.plugin;
    if (bundle === undefined) continue;
    hasCliTool = true;
    const person = entry.as === "person" ? { key: who.person.key } : null;
    const { login } = bundle;
    const requireLogin = async (): Promise<LoginRequired> =>
      person && login
        ? deps.requireLogin(bundle.name, login, person.key)
        : { ok: false, error: `${bundle.name} says the user isn't logged in, and it has no way to log anyone in.` };
    const built = bundle.build({ ...deps.context, person, requireLogin }, bundle.postProcess);
    Object.assign(
      tools,
      entry.as === "mercury" && !who.operator
        ? actingAsMercury(built, { plugin: bundle.name, personKey: who.person.key, rename: entry.variant, log: deps.log })
        : built,
    );
  }
  return { tools, hasCliTool };
}
