/**
 * What the model reads besides the conversation (#387): the layers plugins
 * add, composed by the instance's `context` profiles.
 *
 * - `resolveContext` checks the config at startup. A contradiction in the
 *   config stops the start: a layer pointing at a plugin that isn't
 *   declared, or at one that adds no layer, a plugin listed twice in a
 *   profile, a budget that isn't a whole number. A plugin that didn't load
 *   (a condition outside the config) only loses its layer, with a line. A
 *   layer a profile can never use, its plugin kept by `access` from every
 *   role the profile goes to, gets a warning. The same for the plugin a
 *   profile keeps its conversation with (`conversation`, #393): one not
 *   declared, or keeping none, stops the start, one that didn't load leaves
 *   the profile without; and a plugin keeping conversations that no profile
 *   names stops the start.
 * - `profileFor` picks a person's profile: the first in `assign`, as
 *   written, naming one of their roles; `default` otherwise, and always on
 *   the terminal.
 * - `createContextAssembler` builds a turn's context. A layer runs only for
 *   a plugin offered to the person (the same roles and permissions as its
 *   tools), with the identity its tools would have. Each person's profile
 *   and `session` layers are fixed at their first turn in a session (in a
 *   shared space each sender gets their own, never another's): the layers
 *   go into the system prompt, which stays the same so the model's cache of
 *   the conversation stays valid, and a layer that failed then, or wasn't
 *   offered, stays out for the session. `turn` layers are built every turn
 *   and go in front of the person's message, where the model reads them on
 *   later turns too (`Message.context` in `../session/history.ts`). The budget
 *   counts the blocks' characters: the session layers take it first, in
 *   order, then the turn layers have what's left, in order; a block that
 *   doesn't fit is dropped whole. A layer that fails is skipped and logged.
 *   Each layer gets its knobs as the person's profile sets them, else their
 *   defaults. A profile's order, budget and knobs can change while the
 *   instance runs (`context-settings.ts`): the turn layers follow from the
 *   next turn, the session layers from the next session.
 *
 * Used by: `compose.ts`, which resolves the config after the plugins load
 * and hands the assembler to the turn runner.
 */
import type { ContextRequest, KnobValue, Plugin } from "@mercury-fw/plugin-types";
import type { MercuryContext } from "../config/define-config.ts";
import type { TurnWho } from "../identity/people.ts";
import type { PluginAccess } from "../plugins/offering.ts";
import type { OfferedEntry } from "../plugins/plugin-hooks.ts";
import type { LoadedPlugin } from "../plugins/plugin-loader.ts";

/**
 * A profile as the core uses it: its name, the loaded plugins whose layers it
 * reads, in order, its budget, and the knobs set in it, by plugin (a knob not
 * set has its default). The order, the budget and the knobs change while the
 * instance runs (`context-settings.ts`): the assembler reads them at every turn.
 */
export type ResolvedProfile = {
  name: string;
  layers: LoadedPlugin[];
  maxChars: number;
  knobs: Map<string, Record<string, KnobValue>>;
  /** The plugin keeping the profile's conversations, when it names one that loaded. */
  conversation?: LoadedPlugin;
};

/** The instance's context, checked: its profiles by name, and who gets which, in the order written. */
export type ResolvedContext = { profiles: Map<string, ResolvedProfile>; assign: Array<[profile: string, roles: string[]]> };

/** Checks `context` against the plugins declared and loaded; see the module comment. `undefined` when the instance has none. */
export function resolveContext(
  context: MercuryContext | undefined,
  deps: { declared: Plugin[]; loaded: LoadedPlugin[]; access?: PluginAccess; log: (message: string) => void },
): ResolvedContext | undefined {
  // A plugin keeping conversations that no profile names would never be
  // used: the config contradicts itself.
  const owners = deps.loaded.filter((p) => p.conversation !== undefined);
  const named = new Set(Object.values(context?.profiles ?? {}).flatMap((p) => (p.conversation === undefined ? [] : [p.conversation])));
  for (const owner of owners) {
    if (!named.has(owner.source)) {
      throw new Error(
        `the plugin "${owner.name}" keeps conversations, but no context profile names it as its conversation: name it in context.profiles.<profile>.conversation, or remove it`,
      );
    }
  }
  if (context === undefined) return undefined;
  const declared = new Set(deps.declared);
  const loadedBySource = new Map(deps.loaded.map((p) => [p.source, p]));
  const assign = Object.entries(context.assign ?? {}).filter((entry): entry is [string, string[]] => entry[1] !== undefined);
  const profiles = new Map<string, ResolvedProfile>();
  for (const [name, profile] of Object.entries(context.profiles)) {
    const { maxChars } = profile.budget;
    if (!Number.isInteger(maxChars) || maxChars < 0) {
      throw new Error(`context profile "${name}": budget.maxChars must be a whole number from 0 up`);
    }
    const layers: LoadedPlugin[] = [];
    const listed = new Set<string>();
    for (const plugin of profile.layers) {
      if (listed.has(plugin.name)) {
        throw new Error(`context profile "${name}" lists the plugin "${plugin.name}" twice: its layer would be built and charged twice`);
      }
      listed.add(plugin.name);
      if (!declared.has(plugin)) {
        throw new Error(`context profile "${name}" lists the plugin "${plugin.name}", which isn't in plugins: declare it there, the same object`);
      }
      const loaded = loadedBySource.get(plugin);
      if (loaded === undefined) {
        deps.log(`[context] the plugin "${plugin.name}" isn't loaded: profile "${name}" goes without its layer`);
        continue;
      }
      if (loaded.context === undefined) {
        throw new Error(`context profile "${name}" lists the plugin "${plugin.name}", which has no context layer`);
      }
      layers.push(loaded);
    }
    let conversation: LoadedPlugin | undefined;
    if (profile.conversation !== undefined) {
      const plugin = profile.conversation;
      if (!declared.has(plugin)) {
        throw new Error(`context profile "${name}" keeps its conversation with the plugin "${plugin.name}", which isn't in plugins: declare it there, the same object`);
      }
      conversation = loadedBySource.get(plugin);
      if (conversation === undefined) {
        deps.log(`[context] the plugin "${plugin.name}" isn't loaded: profile "${name}" goes without its conversation`);
      } else if (conversation.conversation === undefined) {
        throw new Error(`context profile "${name}" keeps its conversation with the plugin "${plugin.name}", which keeps none`);
      }
    }
    profiles.set(name, { name, layers, maxChars, knobs: new Map(), ...(conversation === undefined ? {} : { conversation }) });
  }
  for (const [name, roles] of assign) {
    for (const plugin of profiles.get(name)?.layers ?? []) {
      const allowed = deps.access?.[plugin.name]?.roles;
      if (allowed !== undefined && !roles.some((role) => allowed.includes(role))) {
        deps.log(
          `[context] profile "${name}" will never use the layer of "${plugin.name}": it's given to ${roles.join(", ")}, the plugin only to ${allowed.join(", ")}`,
        );
      }
    }
  }
  return { profiles, assign };
}

/** The profile `who` gets; see the module comment. */
export function profileFor(resolved: ResolvedContext, who: TurnWho): ResolvedProfile {
  const fallback = resolved.profiles.get("default")!;
  if (who.operator) return fallback;
  const match = resolved.assign.find(([, roles]) => roles.some((role) => who.person.roles.includes(role)));
  return (match === undefined ? undefined : resolved.profiles.get(match[0])) ?? fallback;
}

/** What one layer contributed to a turn, as the `context.assembled` event reports it. */
export type LayerReport = {
  plugin: string;
  scope: "session" | "turn";
  chars: number;
  blocks: number;
  dropped: number;
  skipped?: "not-offered" | "failed";
};

/** A turn's context: the text for the system prompt and the text in front of the message (each absent when empty), and what the event reports. */
export type ContextAssembly = {
  system?: string;
  turn?: string;
  event: { profile: string; budget: number; used: number; layers: LayerReport[] };
};

/** What the assembler is told about a turn: its session, what the person wrote, whether the space is shared, whether the conversation is one its client reopened. */
export type ContextTurn = { sessionKey: string; input: string; multiUser: boolean; reopened: boolean };

export type ContextAssembler = {
  /** Builds `who`'s context for a turn; never throws. */
  forTurn: (who: TurnWho, turn: ContextTurn) => Promise<ContextAssembly>;
  /** Forgets a session's `session` layers, everyone's: built again if it opens again. */
  forget: (sessionKey: string) => void;
};

/** A layer's blocks once built: what it returned, or why it has none. */
type Built = { plugin: LoadedPlugin; blocks: string[]; skipped?: "not-offered" | "failed" };

/** A person's part of a session, fixed at their first turn in it: their profile, the system text of its `session` layers, the characters used, the reports. */
type SessionPart = { profile: ResolvedProfile; text?: string; used: number; reports: Map<string, LayerReport> };

/** Fits `built`, in order, into `budget` characters, whole blocks only: the texts kept, the characters used, a report per layer. */
function fit(built: Built[], budget: number, scope: "session" | "turn"): { kept: string[]; used: number; reports: LayerReport[] } {
  const kept: string[] = [];
  const reports: LayerReport[] = [];
  let used = 0;
  for (const { plugin, blocks, skipped } of built) {
    const report: LayerReport = { plugin: plugin.name, scope, chars: 0, blocks: 0, dropped: 0, ...(skipped === undefined ? {} : { skipped }) };
    for (const block of blocks) {
      if (used + block.length <= budget) {
        kept.push(block);
        used += block.length;
        report.chars += block.length;
        report.blocks += 1;
      } else {
        report.dropped += 1;
      }
    }
    reports.push(report);
  }
  return { kept, used, reports };
}

/** The knobs `plugin`'s layer gets in `profile`: each one's value set there, else its default. */
function knobsOf(profile: ResolvedProfile, plugin: LoadedPlugin): Record<string, KnobValue> {
  const set = profile.knobs.get(plugin.name) ?? {};
  return Object.fromEntries(Object.entries(plugin.context!.knobs ?? {}).map(([name, spec]) => [name, set[name] ?? spec.default]));
}

/** Builds the context assembler over `resolved`; see the module comment. */
export function createContextAssembler(deps: {
  resolved: ResolvedContext;
  offered: (who: TurnWho) => OfferedEntry[];
  log: (message: string) => void;
}): ContextAssembler {
  /** Each open session's `session` layers, per person who wrote in it: in a shared space each sender has their own. */
  const sessions = new Map<string, Map<string, SessionPart>>();

  /** Builds the layers of `scope` in `profile` for `who`: each offered one's blocks, or why it has none. */
  async function build(profile: ResolvedProfile, scope: "session" | "turn", who: TurnWho, turn: ContextTurn): Promise<Built[]> {
    const offered = deps.offered(who);
    const layers = profile.layers.filter((plugin) => plugin.context!.scope === scope);
    return Promise.all(
      layers.map(async (plugin): Promise<Built> => {
        const entry = offered.find((e) => e.plugin.name === plugin.name);
        if (entry === undefined) return { plugin, blocks: [], skipped: "not-offered" };
        const req: ContextRequest = {
          sessionKey: turn.sessionKey,
          person: { key: who.person.key },
          operator: who.operator,
          as: entry.as,
          input: turn.input,
          multiUser: turn.multiUser,
          knobs: knobsOf(profile, plugin),
          reopened: turn.reopened,
        };
        try {
          return { plugin, blocks: ((await plugin.context!.build(req)) ?? []).filter((b) => typeof b === "string" && b !== "") };
        } catch (err) {
          deps.log(`[context] the layer of "${plugin.name}" failed, skipped: ${err instanceof Error ? err.message : String(err)}`);
          return { plugin, blocks: [], skipped: "failed" };
        }
      }),
    );
  }

  return {
    async forTurn(who, turn) {
      let people = sessions.get(turn.sessionKey);
      if (people === undefined) {
        people = new Map();
        sessions.set(turn.sessionKey, people);
      }
      let session = people.get(who.person.key);
      if (session === undefined) {
        const profile = profileFor(deps.resolved, who);
        const fitted = fit(await build(profile, "session", who, turn), profile.maxChars, "session");
        session = {
          profile,
          ...(fitted.kept.length === 0 ? {} : { text: fitted.kept.join("\n\n") }),
          used: fitted.used,
          reports: new Map(fitted.reports.map((r) => [r.plugin, r])),
        };
        people.set(who.person.key, session);
      }
      const profile = session.profile;
      const forTurn = fit(await build(profile, "turn", who, turn), profile.maxChars - session.used, "turn");
      const turnReports = new Map(forTurn.reports.map((r) => [r.plugin, r]));
      return {
        ...(session.text === undefined ? {} : { system: session.text }),
        ...(forTurn.kept.length === 0 ? {} : { turn: `<context>\n${forTurn.kept.join("\n\n")}\n</context>` }),
        event: {
          profile: profile.name,
          budget: profile.maxChars,
          used: session.used + forTurn.used,
          layers: profile.layers.map((p) => (p.context!.scope === "session" ? session.reports.get(p.name) : turnReports.get(p.name))!),
        },
      };
    },
    forget(sessionKey) {
      sessions.delete(sessionKey);
    },
  };
}
