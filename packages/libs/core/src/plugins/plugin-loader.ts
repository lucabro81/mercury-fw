/**
 * The generic, fail-soft plugin loader. Turns a hand-listed set of plugin
 * modules into what the composition root wires into a running Mercury: the
 * per-plugin tool bundles the model-facing tools are built from, their status
 * describers, the system-prompt fragments, and the post-turn guards. It knows
 * nothing about any specific plugin — or about CLIs — the composition root
 * names them, this loop processes them identically.
 *
 * Two properties it guarantees:
 *  - every plugin the app declares is loaded: declaring it is what enables it;
 *  - a plugin that fails — its `build()` throws — degrades as a single unit:
 *    none of its contributions land, the failure is
 *    logged with detail, and every other plugin and the process itself carry
 *    on. This is the AGENTS.md lesson made structural: one plugin's bad tick
 *    never takes down the rest.
 *
 * The contract types (`Plugin`, `SessionToolContext`, `CliPostProcessor`,
 * `PostTurnGuard`, and the `build()` context) live in `@mercury-fw/plugin-types`,
 * the shared package both the core and the plugins import, so neither mirrors
 * the other. This module keeps only the core-runtime pieces: how a hand-listed
 * set of plugins is loaded and what the load produces.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { PLUGIN_API_VERSION } from "@mercury-fw/plugin-types";
import type {
  Plugin,
  ClosedSession,
  CliPostProcessor,
  ContextLayer,
  ConversationOwner,
  ConversationStore,
  Daily,
  Embed,
  FinishedTurn,
  TurnRecord,
  JobUrgency,
  MercuryModelHandle,
  Messages,
  PersonLogin,
  PluginNeed,
  PostTurnGuard,
  Profiles,
  Skill,
  SessionToolContext,
  ToolLog,
  Translate,
  VectorIndex,
} from "@mercury-fw/plugin-types";
import { catalogErrors } from "../i18n/i18n.ts";
import type { Tool } from "ai";
import { knobSpecError } from "../context/knobs.ts";

/** One plugin's tool contribution, kept paired so the composition root can build
 * its tools from its own post-processor: the plugin authored both, but a
 * formatter decorator wraps the post-processor after `build()` returns, so the
 * factory receives the final one at invocation rather than closing over it. */
export interface SessionToolBundle {
  /** The plugin's name: the service its login is for. */
  name: string;
  build: (ctx: SessionToolContext, postProcess?: CliPostProcessor) => Record<string, Tool>;
  postProcess?: CliPostProcessor;
  /** How the plugin logs a person in, when it acts as the person. */
  login?: PersonLogin;
}

/** One plugin that loaded: what it puts in front of the model, and whose
 * identity it acts with, which decides who it's offered to (the core works
 * that out per person, see `plugins/offering.ts`). A plugin that declares
 * nothing acts as Mercury. */
export interface LoadedPlugin {
  name: string;
  /** What it lets the assistant do, for the model (see `Plugin.description`). */
  description: string;
  actsAs: "person" | "mercury" | "anyone";
  promptFragment?: string;
  skills: Skill[];
  /** Its tool factory, when it contributes tools; the composition root invokes
   * it per turn with the session context (see `SessionToolBundle`). */
  bundle?: SessionToolBundle;
  /** The plugin as the config declared it: what the config points at when it names a plugin by object. */
  source: Plugin;
  /** Its hook for a turn that ended with an answer (see `PluginRuntimeContributions.afterTurn`). */
  afterTurn?: (turn: FinishedTurn) => void | Promise<void>;
  /** Its hook for what each turn and resolved confirmation left (see `PluginRuntimeContributions.onTurnRecord`). */
  onTurnRecord?: (record: TurnRecord) => void | Promise<void>;
  /** Its hook for a session closed for being quiet (see `PluginRuntimeContributions.onSessionClose`). */
  onSessionClose?: (session: ClosedSession) => void | Promise<void>;
  /** What it adds to what the model reads, when a context profile lists it (see `ContextLayer`). */
  context?: ContextLayer;
  /** How it keeps conversations, when a context profile names it as its `conversation` (see `ConversationOwner`). */
  conversation?: ConversationOwner;
}

/** What the loader hands back to the composition root. The core knows nothing
 * about CLIs: a plugin's tool is an opaque `SessionToolBundle` it contributed,
 * not a config the core assembles. */
export interface LoadedPlugins {
  /** Every plugin that loaded, in load order. */
  plugins: LoadedPlugin[];
  /** Merged across plugins, keyed by the tool name each contributes, turning a
   * tool call's input into its status label. */
  toolStatusDescribers: Record<string, (input: unknown, t: Translate) => string>;
  postTurnGuards: PostTurnGuard[];
  /** The English texts of every plugin that activated, merged (see `Plugin.messages`). */
  messages: Messages;
  /** Names of the plugins that fully activated — for read-only introspection
   * (the manifest), since a plugin's tool is opaque and there's no central
   * config map to infer activation from anymore. */
  activated: string[];
  /** Every plugin that didn't activate, with why (the same reason the log gives), in the order they were left out. */
  left: Array<{ name: string; reason: string }>;
}

/** Everything the loader needs from the composition root: the runtime
 * context every `build()` gets. */
export interface PluginLoadContext {
  model: LanguageModel;
  /** The model of a handle a plugin was given (see `PluginRuntimeContext.modelFor`). */
  modelFor?: (handle: MercuryModelHandle) => LanguageModel;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  /** The assistant's name, for what a plugin builds while running (see `PluginRuntimeContext`). */
  assistantName: string;
  /** Runs a plugin's work nobody waits on through the core's queue, named as the traces show it (`<plugin>:<name>`); no plugin gets `job` when absent (see `PluginRuntimeContext.job`). */
  job?: <T>(name: string, urgency: JobUrgency, fn: () => Promise<T>) => Promise<T>;
  /** Where each plugin's own data folder goes (`<root>/<name>`, see
   * `PluginRuntimeContext.dataDir`); no plugin gets one when absent. */
  pluginDataRoot?: string;
  /** The instance's `background` model, queued (see `PluginRuntimeContext.backgroundModel`). */
  backgroundModel?: LanguageModel;
  /** What the instance's config declares of what a plugin may need: a plugin needing anything else stops the start. */
  declared?: PluginNeed[];
  /** What of it started, handed to the plugins that need it: a need declared but missing here leaves its plugin out. */
  provided?: { vectorIndex?: VectorIndex; conversations?: ConversationStore; embed?: Embed };
  /** Runs work every day at a set time, named as the log shows it (`<plugin>:<name>`), returning what cancels it; throws on a time that can't be (see `PluginRuntimeContext.daily`). */
  daily?: (...args: Parameters<Daily>) => () => void;
  /** The tool log, for every plugin (see `PluginRuntimeContext.toolLog`). */
  toolLog?: ToolLog;
  /** People's profiles, for every plugin (see `PluginRuntimeContext.profiles`). */
  profiles?: Profiles;
}

/** What each need is, in the context a plugin gets. */
const NEED_FIELD = { vectorIndex: "vectorIndex", conversationStore: "conversations", embedding: "embed" } as const;

/** The context fields of `needs`, from what the instance provided: only those, and only what is there. */
function neededFields(needs: PluginNeed[], provided: NonNullable<PluginLoadContext["provided"]>): Partial<NonNullable<PluginLoadContext["provided"]>> {
  const fields: Record<string, unknown> = {};
  for (const need of needs) {
    const field = NEED_FIELD[need];
    if (provided[field] !== undefined) fields[field] = provided[field];
  }
  return fields;
}

/** `plugin`'s `job`: the core's queue, with the job named after the plugin. */
function pluginJob(
  plugin: string,
  job: NonNullable<PluginLoadContext["job"]>,
): <T>(name: string, urgency: JobUrgency, fn: () => Promise<T>) => Promise<T> {
  return (name, urgency, fn) => job(`${plugin}:${name}`, urgency, fn);
}

/** `plugin`'s `daily`: the core's, with the work named after the plugin and its cancel kept in `cancels` (a plugin that doesn't load leaves no work behind); a time that can't be is kept in `errors` (it stops the start) and thrown to the plugin too. */
function pluginDaily(plugin: string, daily: NonNullable<PluginLoadContext["daily"]>, errors: string[], cancels: Array<() => void>): Daily {
  return (name, when, fn) => {
    try {
      cancels.push(daily(`${plugin}:${name}`, when, fn));
    } catch (err) {
      errors.push(`plugin "${plugin}": its daily "${name}" can't be set: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
}

/** A plugin name usable as a folder name as is: the rule app names follow too. */
const SAFE_FOLDER_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Creates `plugin`'s data folder under `root` and returns it, or logs why it
 * gets none: a name that isn't a safe folder name, or a folder that can't be
 * created. Never throws: a plugin without a folder still loads. */
function dataDirFor(name: string, root: string | undefined, log: (msg: string) => void): string | undefined {
  if (root === undefined) return undefined;
  if (!SAFE_FOLDER_NAME.test(name)) {
    log(`plugin "${name}" gets no data folder: its name isn't a safe folder name`);
    return undefined;
  }
  const dir = join(root, name);
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    log(`plugin "${name}" gets no data folder: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Orders `plugins` so every plugin comes after each of its declared `dependsOn`
 * (a stable topological sort: among plugins with no ordering constraint between
 * them, listing order is preserved). Only edges to a plugin actually present in
 * the set are honored — an unknown dependency name creates no edge and is
 * caught later, at activation, as an absent dependency. Any plugin left over
 * after the sort is part of, or downstream of, a dependency **cycle**: it comes
 * back in `cyclic`, never in `ordered`, so a cycle degrades fail-soft (the
 * caller skips those plugins) instead of dropping the whole load.
 */
export function orderByDependencies(plugins: Plugin[]): { ordered: Plugin[]; cyclic: Plugin[] } {
  const present = new Set(plugins.map((p) => p.name));
  const remainingDeps = new Map<string, number>();
  for (const p of plugins) {
    // Distinct present dependencies only: the emit loop decrements once per
    // dependency, so counting a name listed twice would wedge the plugin at a
    // count that never reaches zero — misreported as a cycle (regression).
    remainingDeps.set(p.name, new Set((p.dependsOn ?? []).filter((d) => present.has(d))).size);
  }

  const ordered: Plugin[] = [];
  const emitted = new Set<string>();
  // Repeatedly emit every plugin whose remaining dependencies are all already
  // emitted, scanning in listing order so independent plugins keep it. Loop
  // until a full pass emits nothing — whatever is left then is cyclic.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const p of plugins) {
      if (emitted.has(p.name)) continue;
      if ((remainingDeps.get(p.name) ?? 0) !== 0) continue;
      emitted.add(p.name);
      ordered.push(p);
      progressed = true;
      for (const other of plugins) {
        if (!emitted.has(other.name) && (other.dependsOn ?? []).includes(p.name)) {
          remainingDeps.set(other.name, (remainingDeps.get(other.name) ?? 0) - 1);
        }
      }
    }
  }

  const cyclic = plugins.filter((p) => !emitted.has(p.name));
  return { ordered, cyclic };
}

/**
 * Loads every plugin in `plugins`, returning their combined contributions.
 * Plugins load in dependency-first order (see `orderByDependencies`), not
 * listing order — though listing order is preserved among plugins with no
 * dependency between them. Never throws — a plugin that fails is logged and
 * skipped, its contributions staged and merged only once the whole plugin
 * succeeds so a later failure can't leave it half-wired. A plugin whose
 * declared `dependsOn` isn't fully activated (a dependency failed, unknown,
 * or itself skipped) is skipped fail-soft too, transitively.
 */
export async function loadPlugins(plugins: Plugin[], ctx: PluginLoadContext): Promise<LoadedPlugins> {
  const loaded: LoadedPlugin[] = [];
  const toolStatusDescribers: Record<string, (input: unknown, t: Translate) => string> = {};
  const postTurnGuards: PostTurnGuard[] = [];
  const messages: Messages = {};

  const left: Array<{ name: string; reason: string }> = [];
  /** Logs that `name` didn't activate and why, and keeps it for the startup report. */
  const leaveOut = (name: string, reason: string, logged = `plugin "${name}" not activated: ${reason}`) => {
    ctx.log(logged);
    left.push({ name, reason });
  };

  // A plugin needing what the config doesn't declare is a config that can't
  // work: the start stops before any plugin builds.
  const declared = new Set(ctx.declared ?? []);
  for (const plugin of plugins) {
    const missing = (plugin.needs ?? []).find((need) => !declared.has(need));
    if (missing !== undefined) throw new Error(`plugin "${plugin.name}" needs the instance's ${missing}, which mercury.config.ts doesn't declare`);
  }
  // A plugin's daily at a time that can't be is a mistake in the config as
  // well, found while it builds: the start stops once the plugins are done.
  const configErrors: string[] = [];

  const { ordered, cyclic } = orderByDependencies(plugins);
  // A plugin caught in a cycle can't be ordered, so it can't load.
  for (const plugin of cyclic) {
    leaveOut(plugin.name, "part of or depends on a dependency cycle");
  }

  // Names that fully activated — a dependency must be in here for a dependent
  // to load. Populated in dependency-first order, so a dependent is always
  // processed after its dependencies have had their chance.
  const activated = new Set<string>();

  for (const plugin of ordered) {
    // Contract-version skew: core and plugin are versioned and installed
    // separately, so a plugin built against a different contract than this core
    // supports is possible. Refuse it fail-soft rather than run it against a
    // shape it may not match.
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      leaveOut(plugin.name, `apiVersion ${plugin.apiVersion} incompatible with this core (supports ${PLUGIN_API_VERSION})`);
      continue;
    }
    // Every declared dependency must have fully activated first. Because we
    // process in dependency-first order, a dependency that was going to load
    // already has; anything still missing failed, is unknown, or was itself
    // skipped — so this dependent degrades fail-soft too. Checked before
    // touching this plugin's own build, so a doomed plugin does no work.
    const missingDeps = (plugin.dependsOn ?? []).filter((dep) => !activated.has(dep));
    if (missingDeps.length > 0) {
      leaveOut(plugin.name, `dependency ${missingDeps.map((d) => `"${d}"`).join(", ")} absent or failed`);
      continue;
    }
    // The type asks for it, but a plugin built without the types reaches the
    // loader anyway: the model would have nothing to say about it.
    if (typeof plugin.description !== "string" || plugin.description.trim() === "") {
      leaveOut(plugin.name, "it has no description");
      continue;
    }
    // The prompt lists the plugins one per line: a line break inside would
    // split this one's entry.
    const description = plugin.description.trim();
    if (/[\r\n]/.test(description)) {
      leaveOut(plugin.name, "its description isn't one line");
      continue;
    }
    // A plugin's texts are its own: a key outside its name could shadow
    // another plugin's or the core's, and the core's and the app's names
    // are taken.
    const textErrors = catalogErrors(plugin.name, plugin.messages ?? {});
    if (textErrors.length > 0) {
      leaveOut(plugin.name, textErrors.join("; "));
      continue;
    }
    // A need the config declares but that didn't start (an index that
    // isn't reachable at build time) is the outside world: the plugin is
    // left out, the rest goes on.
    const notStarted = (plugin.needs ?? []).find((need) => ctx.provided?.[NEED_FIELD[need]] === undefined);
    if (notStarted !== undefined) {
      leaveOut(plugin.name, `the instance's ${notStarted} didn't start`);
      continue;
    }
    // The daily work it registers while building, cancelled if it doesn't load.
    const cancels: Array<() => void> = [];
    try {
      // Stage into locals first: build() can throw, and a plugin must degrade
      // as a unit — nothing of it lands unless all of it succeeds.
      const dataDir = plugin.build ? dataDirFor(plugin.name, ctx.pluginDataRoot, ctx.log) : undefined;
      const contributions = plugin.build
        ? await plugin.build({
            model: ctx.model,
            ...(ctx.modelFor === undefined ? {} : { modelFor: ctx.modelFor }),
            env: ctx.env,
            log: ctx.log,
            assistantName: ctx.assistantName,
            ...(dataDir === undefined ? {} : { dataDir }),
            ...(ctx.job === undefined ? {} : { job: pluginJob(plugin.name, ctx.job) }),
            ...(ctx.backgroundModel === undefined ? {} : { backgroundModel: ctx.backgroundModel }),
            ...neededFields(plugin.needs ?? [], ctx.provided ?? {}),
            ...(ctx.daily === undefined ? {} : { daily: pluginDaily(plugin.name, ctx.daily, configErrors, cancels) }),
            ...(ctx.toolLog === undefined ? {} : { toolLog: ctx.toolLog }),
            ...(ctx.profiles === undefined ? {} : { profiles: ctx.profiles }),
          })
        : {};
      // A knob's spec is what an admin area draws and checks values against:
      // one that contradicts itself would refuse every value, its default too.
      for (const [knob, spec] of Object.entries(contributions.context?.knobs ?? {})) {
        const error = knobSpecError(spec);
        if (error !== undefined) throw new Error(`its context knob "${knob}" doesn't hold: ${error}`);
      }

      const bundle: SessionToolBundle | undefined = contributions.sessionTools
        ? {
            name: plugin.name,
            build: contributions.sessionTools,
            ...(contributions.postProcess === undefined ? {} : { postProcess: contributions.postProcess }),
            ...(contributions.login === undefined ? {} : { login: contributions.login }),
          }
        : undefined;
      const actsAs = plugin.actsAs === "person" || plugin.actsAs === "anyone" ? plugin.actsAs : "mercury";
      loaded.push({
        name: plugin.name,
        description,
        actsAs,
        ...(plugin.systemPromptFragment === undefined ? {} : { promptFragment: plugin.systemPromptFragment }),
        skills: [...(plugin.skills ?? [])],
        ...(bundle === undefined ? {} : { bundle }),
        source: plugin,
        ...(contributions.afterTurn === undefined ? {} : { afterTurn: contributions.afterTurn }),
        ...(contributions.onTurnRecord === undefined ? {} : { onTurnRecord: contributions.onTurnRecord }),
        ...(contributions.onSessionClose === undefined ? {} : { onSessionClose: contributions.onSessionClose }),
        ...(contributions.context === undefined ? {} : { context: contributions.context }),
        ...(contributions.conversation === undefined ? {} : { conversation: contributions.conversation }),
      });
      if (actsAs === "mercury") {
        ctx.log(
          `plugin "${plugin.name}" acts as Mercury itself: offered only to people holding mercury.act-as-self or mercury.act-as-self.${plugin.name}, and on the terminal`,
        );
      }
      if (contributions.toolStatusDescribers) {
        Object.assign(toolStatusDescribers, contributions.toolStatusDescribers);
      }
      if (contributions.postTurnGuards) {
        postTurnGuards.push(...contributions.postTurnGuards);
      }
      Object.assign(messages, plugin.messages);
      // Fully wired — only now does it count as a satisfied dependency for
      // anything that declared `dependsOn` on it.
      activated.add(plugin.name);
    } catch (err) {
      for (const cancel of cancels) cancel();
      const message = err instanceof Error ? err.message : String(err);
      leaveOut(plugin.name, `failed to load: ${message}`, `plugin "${plugin.name}" failed to load, skipped: ${message}`);
    }
  }

  if (configErrors.length > 0) throw new Error(configErrors.join("; "));
  return { plugins: loaded, toolStatusDescribers, postTurnGuards, messages, activated: [...activated], left };
}
