import { describe, it, expect } from "bun:test";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { loadPlugins, type PluginLoadContext } from "./plugin-loader.ts";

/**
 * The generic, fail-soft plugin loader — the mechanism the composition root
 * uses to turn a hand-listed set of plugin modules into the per-plugin tool
 * bundles, prompt fragments, status describers, and post-turn guards. It knows
 * nothing about any specific plugin — or about CLIs — these tests drive it with
 * synthetic ones. A real plugin's own `build()` behaviour is tested in that
 * plugin's package.
 *
 * The invariants that matter: every declared plugin is loaded when it
 * declares a compatible `apiVersion`; a plugin that fails — a
 * throwing `build()` — degrades as a whole unit (never half-wired) without
 * taking down the other plugins or the process; and activation is reported in
 * `activated` (there is no central config map to infer it from anymore).
 */
/** A synthetic plugin, defaulting to the compatible apiVersion and to acting
 * as the person (offered to everyone, nothing logged about it). */
function plug(p: Partial<Plugin> & Pick<Plugin, "name">): Plugin {
  return { apiVersion: PLUGIN_API_VERSION, actsAs: "person", ...p };
}

function baseCtx(overrides: Partial<PluginLoadContext> = {}): PluginLoadContext {
  return {
    model: {} as never,
    env: {},
    log: () => {},
    ...overrides,
  };
}

describe("loadPlugins", () => {
  it("activates an enabled plugin and collects its fragment", async () => {
    const plugin = plug({ name: "jira", systemPromptFragment: "FRAG" });
    const loaded = await loadPlugins([plugin], baseCtx());
    expect(loaded.activated).toEqual(["jira"]);
    expect(loaded.promptFragments).toEqual(["FRAG"]);
    expect(loaded.sessionToolBundles).toEqual([]);
    expect(loaded.postTurnGuards).toEqual([]);
  });

  it("bundles a plugin's sessionTools factory with its post-processor, and collects its guards", async () => {
    const pp = (() => {}) as never;
    const factory = () => ({ jiraCommand: {} as never });
    const guard = { statusLabel: "l", statusId: "g", shouldRun: () => true, run: async () => ({ text: "", outcome: "success" as const }) };
    const plugin = plug({ name: "jira", build: () => ({ postProcess: pp, sessionTools: factory, postTurnGuards: [guard] }) });
    const loaded = await loadPlugins([plugin], baseCtx());
    expect(loaded.sessionToolBundles).toEqual([{ name: "jira", build: factory, postProcess: pp }]);
    expect(loaded.postTurnGuards).toEqual([guard]);
  });

  it("merges toolStatusDescribers across plugins, keyed by tool name", async () => {
    const jiraDescribe = () => "esecuzione jira";
    const bbDescribe = () => "esecuzione bitbucket";
    const p1 = plug({ name: "jira", build: () => ({ toolStatusDescribers: { jiraCommand: jiraDescribe } }) });
    const p2 = plug({ name: "bitbucket", build: () => ({ toolStatusDescribers: { bitbucketCommand: bbDescribe } }) });
    const loaded = await loadPlugins([p1, p2], baseCtx());
    expect(loaded.toolStatusDescribers).toEqual({ jiraCommand: jiraDescribe, bitbucketCommand: bbDescribe });
  });

  it("passes the runtime context (model, env, log) through to build()", async () => {
    let seen: unknown;
    const model = { id: "m" } as never;
    const plugin = plug({ name: "jira", build: (ctx) => { seen = ctx; return {}; } });
    await loadPlugins([plugin], baseCtx({ model, env: { JIRA_SITE_URL: "u" } }));
    expect((seen as { model: unknown }).model).toBe(model);
    expect((seen as { env: unknown }).env).toEqual({ JIRA_SITE_URL: "u" });
    expect(typeof (seen as { log: unknown }).log).toBe("function");
  });

  // #142: a declared plugin also had to be listed in MERCURY_CLIS, or the
  // loader skipped it without a word.
  it("loads every declared plugin, with nothing else to enable it", async () => {
    let built = false;
    const plugin = plug({ name: "jira", systemPromptFragment: "FRAG", build: () => ((built = true), {}) });
    const loaded = await loadPlugins([plugin], baseCtx());
    expect(built).toBe(true);
    expect(loaded.activated).toEqual(["jira"]);
    expect(loaded.promptFragments).toEqual(["FRAG"]);
  });

  it("skips a plugin whose apiVersion is incompatible with this core — logs why, does not build it", async () => {
    const logs: string[] = [];
    let built = false;
    const plugin = plug({
      name: "jira",
      apiVersion: PLUGIN_API_VERSION + 1,
      systemPromptFragment: "FRAG",
      build: () => { built = true; return {}; },
    });
    const loaded = await loadPlugins([plugin], baseCtx({ log: (m) => logs.push(m) }));
    expect(built).toBe(false);
    expect(loaded.activated).toEqual([]);
    expect(loaded.promptFragments).toEqual([]);
    expect(logs.some((l) => l.includes("jira") && l.includes("apiVersion") && l.includes("incompatible"))).toBe(true);
  });

  it("degrades a plugin as a unit: a throwing build() contributes nothing and doesn't stop the others", async () => {
    const logs: string[] = [];
    const bad = plug({ name: "bad", systemPromptFragment: "B", build: () => { throw new Error("kaboom"); } });
    const good = plug({ name: "good", systemPromptFragment: "G" });
    const loaded = await loadPlugins([bad, good], baseCtx({ log: (m) => logs.push(m) }));
    expect(loaded.activated).toEqual(["good"]);
    expect(loaded.promptFragments).toEqual(["G"]);
    expect(logs.some((l) => l.includes("bad") && l.includes("failed to load") && l.includes("kaboom"))).toBe(true);
  });

  it("aggregates multiple plugins in listing order — bundles per plugin, concatenates fragments and guards", async () => {
    const fA = () => ({ a: {} as never });
    const fB = () => ({ b: {} as never });
    const gA = { statusLabel: "a", statusId: "a", shouldRun: () => true, run: async () => ({ text: "", outcome: "success" as const }) };
    const gB = { statusLabel: "b", statusId: "b", shouldRun: () => true, run: async () => ({ text: "", outcome: "success" as const }) };
    const p1 = plug({ name: "p1", systemPromptFragment: "F1", build: () => ({ sessionTools: fA, postTurnGuards: [gA] }) });
    const p2 = plug({ name: "p2", systemPromptFragment: "F2", build: () => ({ sessionTools: fB, postTurnGuards: [gB] }) });
    const loaded = await loadPlugins([p1, p2], baseCtx());
    expect(loaded.activated).toEqual(["p1", "p2"]);
    expect(loaded.promptFragments).toEqual(["F1", "F2"]);
    expect(loaded.sessionToolBundles).toEqual([
      { name: "p1", build: fA },
      { name: "p2", build: fB },
    ]);
    expect(loaded.postTurnGuards).toEqual([gA, gB]);
  });

  it("concatenates the skills of every loaded plugin, in listing order", async () => {
    const s1 = { name: "a", description: "da", body: "ba" };
    const s2 = { name: "b", description: "db", body: "bb" };
    const p1 = plug({ name: "p1", skills: [s1] });
    const p2 = plug({ name: "p2", skills: [s2] });
    const plain = plug({ name: "plain" });
    const loaded = await loadPlugins([p1, plain, p2], baseCtx());
    expect(loaded.skills).toEqual([s1, s2]);
  });
});

// #176: whose identity a plugin acts with decides who it's offered to.
describe("loadPlugins: who each plugin is offered to", () => {
  const login = { start: async () => ({ ok: false as const, error: "x" }), complete: async () => ({ ok: true as const }) };
  const tools = () => ({ t: {} as never });

  it("offers a plugin acting as the person to people too, with its login", async () => {
    const plugin = plug({
      name: "jira",
      actsAs: "person",
      systemPromptFragment: "FRAG",
      skills: [{ name: "jira", description: "d", body: "b" }],
      build: () => ({ sessionTools: tools, login }),
    });
    const loaded = await loadPlugins([plugin], baseCtx());
    expect(loaded.sessionToolBundles).toEqual([{ name: "jira", build: tools, login }]);
    expect(loaded.forPeople).toEqual({
      promptFragments: ["FRAG"],
      skills: [{ name: "jira", description: "d", body: "b" }],
      sessionToolBundles: [{ name: "jira", build: tools, login }],
    });
  });

  it("keeps a plugin acting as Mercury, or declaring nothing, out of what people are offered, and says so once", async () => {
    const logs: string[] = [];
    const asMercury = plug({ name: "admin", actsAs: "mercury", systemPromptFragment: "ADMIN", build: () => ({ sessionTools: tools }) });
    const undeclared = plug({ name: "other", actsAs: undefined, skills: [{ name: "other", description: "d", body: "b" }] });
    const loaded = await loadPlugins([asMercury, undeclared], baseCtx({ log: (m) => logs.push(m) }));
    expect(loaded.activated).toEqual(["admin", "other"]);
    expect(loaded.promptFragments).toEqual(["ADMIN"]);
    expect(loaded.skills.map((s) => s.name)).toEqual(["other"]);
    expect(loaded.sessionToolBundles.map((b) => b.name)).toEqual(["admin"]);
    expect(loaded.forPeople).toEqual({ promptFragments: [], skills: [], sessionToolBundles: [] });
    expect(logs).toEqual([
      'plugin "admin" acts as Mercury itself: offered on the terminal only, until people can be allowed to make Mercury act as itself',
      'plugin "other" acts as Mercury itself: offered on the terminal only, until people can be allowed to make Mercury act as itself',
    ]);
  });
});

describe("loadPlugins dependsOn", () => {
  function recordingPlugin(name: string, order: string[], dependsOn?: string[]): Plugin {
    return plug({
      name,
      dependsOn,
      systemPromptFragment: name.toUpperCase(),
      build: () => { order.push(name); return {}; },
    });
  }

  it("loads a dependency before its dependent, even when the dependent is listed first", async () => {
    const order: string[] = [];
    const dependent = recordingPlugin("dependent", order, ["dep"]);
    const dep = recordingPlugin("dep", order);
    const loaded = await loadPlugins([dependent, dep], baseCtx());
    expect(order).toEqual(["dep", "dependent"]);
    expect(loaded.activated).toEqual(["dep", "dependent"]);
  });

  it("keeps listing order among plugins with no dependency between them", async () => {
    const order: string[] = [];
    const a = recordingPlugin("a", order);
    const b = recordingPlugin("b", order);
    const loaded = await loadPlugins([a, b], baseCtx());
    expect(order).toEqual(["a", "b"]);
    expect(loaded.activated).toEqual(["a", "b"]);
  });

  it("skips a dependent whose dependency failed to build, propagating transitively", async () => {
    const logs: string[] = [];
    const order: string[] = [];
    const a = recordingPlugin("a", order); // ok
    const b = plug({ name: "b", dependsOn: ["a"], build: () => { throw new Error("kaboom"); } });
    const c = recordingPlugin("c", order, ["b"]); // depends on the one that throws
    const loaded = await loadPlugins([a, b, c], baseCtx({ log: (m) => logs.push(m) }));
    expect(loaded.activated).toEqual(["a"]); // only a survives
    expect(order).not.toContain("c");
    expect(logs.some((l) => l.includes("b") && l.includes("kaboom"))).toBe(true);
    expect(logs.some((l) => l.includes("c") && l.includes("b"))).toBe(true);
  });

  it("skips a dependent that names an unknown dependency", async () => {
    const logs: string[] = [];
    const order: string[] = [];
    const dependent = recordingPlugin("dependent", order, ["ghost"]);
    const loaded = await loadPlugins([dependent], baseCtx({ log: (m) => logs.push(m) }));
    expect(loaded.activated).toEqual([]);
    expect(order).not.toContain("dependent");
    expect(logs.some((l) => l.includes("dependent") && l.includes("ghost"))).toBe(true);
  });

  it("breaks a dependency cycle fail-soft, still loading unrelated plugins", async () => {
    const logs: string[] = [];
    const order: string[] = [];
    const a = recordingPlugin("a", order, ["b"]);
    const b = recordingPlugin("b", order, ["a"]); // a <-> b cycle
    const c = recordingPlugin("c", order);
    const loaded = await loadPlugins([a, b, c], baseCtx({ log: (m) => logs.push(m) }));
    expect(loaded.activated).toEqual(["c"]);
    expect(order).toEqual(["c"]);
    // Each plugin in the cycle reported by name, the unrelated one not at all.
    expect(logs).toEqual([
      'plugin "a" not activated: part of or depends on a dependency cycle',
      'plugin "b" not activated: part of or depends on a dependency cycle',
    ]);
  });

  it("loads a chain of dependencies in order (a <- b <- c)", async () => {
    const order: string[] = [];
    const a = recordingPlugin("a", order);
    const b = recordingPlugin("b", order, ["a"]);
    const c = recordingPlugin("c", order, ["b"]);
    // listed out of dependency order on purpose
    const loaded = await loadPlugins([c, b, a], baseCtx());
    expect(order).toEqual(["a", "b", "c"]);
    expect(loaded.activated).toEqual(["a", "b", "c"]);
  });

  it("loads a diamond (d depends on b and c, both on a) in a valid order", async () => {
    const order: string[] = [];
    const a = recordingPlugin("a", order);
    const b = recordingPlugin("b", order, ["a"]);
    const c = recordingPlugin("c", order, ["a"]);
    const d = recordingPlugin("d", order, ["b", "c"]);
    const loaded = await loadPlugins([d, b, c, a], baseCtx());
    // a before b and c; b and c before d. b and c keep listing order (b, c).
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(loaded.activated).toEqual(["a", "b", "c", "d"]);
  });

  it("treats a self-dependency as unsatisfiable and skips it fail-soft, loading the rest", async () => {
    const logs: string[] = [];
    const order: string[] = [];
    const selfish = recordingPlugin("selfish", order, ["selfish"]);
    const other = recordingPlugin("other", order);
    const loaded = await loadPlugins([selfish, other], baseCtx({ log: (m) => logs.push(m) }));
    expect(loaded.activated).toEqual(["other"]);
    expect(order).toEqual(["other"]);
    expect(logs.some((l) => l.includes("selfish"))).toBe(true);
  });

  // Regression: a duplicated name in `dependsOn` (["a","a"]) once inflated the
  // dependency count past what the emit loop could decrement, wedging a plugin
  // whose dependency had actually loaded into the "cycle" bucket and dropping it
  // with a misleading reason. A present, loaded dependency must satisfy the
  // dependent no matter how many times it's listed.
  it("does not miscount a dependency named more than once in dependsOn", async () => {
    const order: string[] = [];
    const a = recordingPlugin("a", order);
    const dependent = recordingPlugin("dependent", order, ["a", "a"]);
    const loaded = await loadPlugins([dependent, a], baseCtx());
    expect(order).toEqual(["a", "dependent"]);
    expect(loaded.activated).toEqual(["a", "dependent"]);
  });
});
