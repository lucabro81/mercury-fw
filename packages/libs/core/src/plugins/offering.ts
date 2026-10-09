/**
 * What a person is offered of the loaded plugins, decided by the core before
 * the turn so the model never sees a tool it isn't allowed to use.
 *
 * - A plugin acting as the person is offered to everyone, run as them.
 * - Making Mercury act as itself takes `mercury.act-as-self` (every plugin) or
 *   `mercury.act-as-self.<plugin>` (that one): a plugin acting as Mercury is
 *   offered only then, and a plugin acting as the person gets a variant beside
 *   the person's own that runs with Mercury's identity.
 * - The installer can restrict a plugin to some roles (`access.plugins` in
 *   `mercury.config.ts`): whoever holds none of them doesn't get it at all.
 * - The operator (the terminal, whoever has the container's shell) gets every
 *   plugin, as Mercury, under its own names.
 */
import type { Skill } from "@mercury-fw/plugin-types";
import type { LoadedPlugin } from "./plugin-loader.ts";

/** The core's permission to make Mercury act as itself; `.<plugin>` scopes it to one plugin. */
export const ACT_AS_SELF = "mercury.act-as-self";

/** One plugin as offered: as whom its tools act, and whether it's the variant
 * acting as Mercury beside the person's own (its tools then get other names). */
export type OfferedPlugin = { plugin: LoadedPlugin; as: "person" | "mercury"; variant: boolean };

export type Offering = {
  entries: OfferedPlugin[];
  promptFragments: string[];
  skills: Skill[];
  /** Equal for equal offerings: what the prompts built from it are memoized on. */
  signature: string;
};

/** The installer's restriction: a plugin's name to the roles that may use it. */
export type PluginAccess = Record<string, { roles: string[] }>;

/** What `who` is offered of `plugins` (see the module comment). */
export function offeringFor(
  plugins: LoadedPlugin[],
  who: { roles: string[]; operator: boolean },
  access: PluginAccess = {},
): Offering {
  const roles = new Set(who.roles);
  const entries: OfferedPlugin[] = [];
  for (const plugin of plugins) {
    if (who.operator) {
      entries.push({ plugin, as: "mercury", variant: false });
      continue;
    }
    const allowedRoles = access[plugin.name]?.roles;
    if (allowedRoles !== undefined && !allowedRoles.some((r) => roles.has(r))) continue;
    const actsAsSelf = roles.has(ACT_AS_SELF) || roles.has(`${ACT_AS_SELF}.${plugin.name}`);
    if (plugin.actsAs === "person") {
      entries.push({ plugin, as: "person", variant: false });
      if (actsAsSelf) entries.push({ plugin, as: "mercury", variant: true });
    } else if (actsAsSelf) {
      entries.push({ plugin, as: "mercury", variant: false });
    }
  }

  const offered = [...new Map(entries.map((e) => [e.plugin.name, e.plugin])).values()];
  return {
    entries,
    promptFragments: offered.flatMap((p) => (p.promptFragment === undefined ? [] : [p.promptFragment])),
    skills: offered.flatMap((p) => p.skills),
    signature: entries.map((e) => `${e.plugin.name}:${e.as}${e.variant ? "+" : ""}`).join(","),
  };
}
