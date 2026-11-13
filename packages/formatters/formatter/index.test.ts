/**
 * Tests for the formatter: `formatter(rules)` applies an instance's rule for a
 * display's kind and nothing else, and `formatterPlugin(plugin, handler)` wraps
 * the tools a data plugin contributes so every display they return goes
 * through the handler — passing every other contribution through untouched. Synthetic
 * plugins and item shapes only: this pins the mechanism, not any real plugin.
 */
import { describe, expect, test } from "bun:test";
import {
  PLUGIN_API_VERSION,
  type Plugin,
  type PluginRuntimeContributions,
  type PluginRuntimeContext,
  type CliResult,
  type ExecutableTool,
  type SessionToolContext,
  type Translate,
} from "@mercury-fw/plugin-types";
import { formatter, formatterPlugin } from "./index.ts";

/** A tool as `sessionTools` contributes it. */
type Tool = ExecutableTool;

type Displays = {
  "thing-list": { id: string; label: string | null };
  "other-list": { n: number };
};

const thingLine = (thing: Displays["thing-list"]) => `${thing.id}${thing.label ? ` (${thing.label})` : ""}`;

/** The turn's texts: the key and its params, so a test sees what was asked for. */
const t: Translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

describe("formatter", () => {
  test("renders each item with the rule for the display's kind, one blank line apart", () => {
    const render = formatter<Displays>({ "thing-list": thingLine });
    expect(render({ type: "thing-list", items: [{ id: "A", label: "a" }, { id: "B", label: null }] }, t)).toEqual({ text: "A (a)\n\nB" });
  });

  test("picks the rule by kind when several are configured", () => {
    const render = formatter<Displays>({ "thing-list": thingLine, "other-list": (o) => `#${o.n}` });
    expect(render({ type: "other-list", items: [{ n: 1 }, { n: 2 }] }, t)).toEqual({ text: "#1\n\n#2" });
    expect(render({ type: "thing-list", items: [{ id: "A", label: null }] }, t)).toEqual({ text: "A" });
  });

  test("accepts a rule in object form, with the same per-item line", () => {
    const render = formatter<Displays>({ "thing-list": { item: thingLine } });
    expect(render({ type: "thing-list", items: [{ id: "A", label: null }, { id: "B", label: "b" }] }, t)).toEqual({ text: "A\n\nB (b)" });
  });

  test("shows the rule's empty text for an empty list", () => {
    const render = formatter<Displays>({ "thing-list": { item: thingLine, empty: "Nothing here." } });
    expect(render({ type: "thing-list", items: [] }, t)).toEqual({ text: "Nothing here." });
  });

  // #280: an app's rules write text a person reads, so they get the turn's
  // language too: the item line, and the empty text as a function of it.
  test("hands the rules the turn's texts, for the item line and the empty text", () => {
    const render = formatter<Displays>({
      "thing-list": { item: (thing, tr) => tr("app.thing", { id: thing.id }), empty: (tr) => tr("app.none") },
    });
    expect(render({ type: "thing-list", items: [{ id: "A", label: null }] }, t)).toEqual({ text: 'app.thing {"id":"A"}' });
    expect(render({ type: "thing-list", items: [] }, t)).toEqual({ text: "app.none" });
  });

  test("has nothing to show for an empty list when the rule sets no empty text", () => {
    expect(formatter<Displays>({ "thing-list": thingLine })({ type: "thing-list", items: [] }, t)).toBeUndefined();
    expect(formatter<Displays>({ "thing-list": { item: thingLine } })({ type: "thing-list", items: [] }, t)).toBeUndefined();
  });

  test("has nothing to show for a kind with no rule", () => {
    const render = formatter<Displays>({ "thing-list": thingLine });
    expect(render({ type: "other-list", items: [{ n: 1 }] }, t)).toBeUndefined();
    expect(render({ type: "never-declared", items: [{ x: 1 }] }, t)).toBeUndefined();
  });

  // #376: a kind whose display is the answer itself (a link the person asked
  // for) is shown without the model calling `present`: the instance says so in
  // its rule, and the handler carries it next to the text.
  test("marks the text to show always when the rule says so, the empty text too", () => {
    const render = formatter<Displays>({ "thing-list": { item: thingLine, empty: "None.", always: true } });
    expect(render({ type: "thing-list", items: [{ id: "A", label: null }] }, t)).toEqual({ text: "A", always: true });
    expect(render({ type: "thing-list", items: [] }, t)).toEqual({ text: "None.", always: true });
  });

  test("has nothing to show for an empty list with no empty text, even when always", () => {
    expect(formatter<Displays>({ "thing-list": { item: thingLine, always: true } })({ type: "thing-list", items: [] }, t)).toBeUndefined();
  });

  test("rejects, at compile time, a kind the plugin doesn't declare", async () => {
    // @ts-expect-error — "thing-lsit" is not a declared kind
    formatter<Displays>({ "thing-lsit": thingLine });
    // @ts-expect-error — the rule's item type must match the kind's item shape
    formatter<Displays>({ "other-list": thingLine });
  });
});

const logs: string[] = [];
const ctx: PluginRuntimeContext = { model: {} as never, env: {}, log: (m) => logs.push(m) };
/** The per-turn context the core hands `sessionTools`; only `t` matters here. */
const sctx = { sessionKey: "s", t } as unknown as SessionToolContext;
const callOptions = { toolCallId: "c1", messages: [] };

/** A minimal plugin whose `build` returns exactly the contributions given. */
function pluginWith(contributions: PluginRuntimeContributions, extra: Partial<Plugin> = {}): Plugin {
  return { apiVersion: PLUGIN_API_VERSION, name: "data", description: "Reads data.", build: () => contributions, ...extra };
}

/** A plugin with one tool, `find`, whose `execute` always returns `output`. */
function emitting(output: unknown, extra: Partial<Plugin> = {}): Plugin {
  return pluginWith({ sessionTools: () => ({ find: { description: "Finds.", execute: async () => output } as unknown as Tool }) }, extra);
}

/** Builds `plugin` and runs its tool `name` with `input`, as the core would. */
async function run(plugin: Plugin, input: unknown = {}, name = "find"): Promise<unknown> {
  const tools = (await plugin.build!(ctx)).sessionTools!(sctx);
  return (tools[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, callOptions);
}

// #375: a typed tool's display (a plugin with `sessionTools` and no
// post-processor) went straight to the model, the instance's rules never
// applied; the formatter now wraps what every tool returns, CLI or typed.
describe("formatterPlugin", () => {
  test("replaces an ok result's structured items with the handler's single rendered block", async () => {
    let seen: unknown;
    const decorated = formatterPlugin(
      emitting({ ok: true, query: "q", display: { type: "thing-list", items: [{ id: "A" }, { id: "B" }] } }),
      (display) => {
        seen = display;
        return { text: "RENDERED" };
      },
    );

    expect(await run(decorated)).toEqual({ ok: true, query: "q", display: { type: "thing-list", items: ["RENDERED"] } });
    expect(seen).toEqual({ type: "thing-list", items: [{ id: "A" }, { id: "B" }] });
  });

  test("marks the rendered display to show always when the handler says so", async () => {
    const decorated = formatterPlugin(emitting({ ok: true, display: { type: "thing-list", items: [{ id: "A" }] } }), () => ({
      text: "LINK",
      always: true,
    }));
    expect(await run(decorated)).toEqual({ ok: true, display: { type: "thing-list", items: ["LINK"], always: true } });
  });

  test("hands the handler the turn's texts", async () => {
    const seen: string[] = [];
    const decorated = formatterPlugin(emitting({ ok: true, display: { type: "thing-list", items: [{ id: "A" }] } }), (_d, tr) => (
      seen.push(tr("handler")), { text: "R" }
    ));
    await run(decorated);
    expect(seen).toEqual(["handler"]);
  });

  test("hands the tool the call's input and options, and the factory the session context and post-processor", async () => {
    let received: unknown[] = [];
    let factoryArgs: unknown[] = [];
    const postProcess = (_c: unknown, r: CliResult) => r;
    const base = pluginWith({
      postProcess,
      sessionTools: (...args) => {
        factoryArgs = args;
        return { find: { execute: async (...a: unknown[]) => ((received = a), { ok: true }) } as Tool };
      },
    });
    const built = (await formatterPlugin(base, () => ({ text: "R" })).build!(ctx));
    const tools = built.sessionTools!(sctx, postProcess);
    await (tools.find!.execute as (i: unknown, o: unknown) => Promise<unknown>)({ query: "x" }, callOptions);

    expect(received).toEqual([{ query: "x" }, callOptions]);
    expect(factoryArgs).toEqual([sctx, postProcess]);
    // The post-processor isn't wrapped any more: what the CLI tool returns is.
    expect(built.postProcess).toBe(postProcess);
  });

  test("drops the display when the handler has nothing to show for an empty list", async () => {
    const decorated = formatterPlugin(emitting({ ok: true, data: { raw: 1 }, display: { type: "thing-list", items: [] } }), () => undefined);
    expect(await run(decorated)).toEqual({ ok: true, data: { raw: 1 } });
  });

  test("leaves a non-empty display structured, and logs it, when the handler has no rule for its kind", async () => {
    logs.length = 0;
    const emitted = { ok: true, data: {}, display: { type: "thing-list", items: [{ id: "A" }] } };
    const decorated = formatterPlugin(emitting(emitted, { name: "jira" }), () => undefined);

    expect(await run(decorated)).toEqual(emitted);
    expect(logs).toEqual(['[formatter] no rule for "thing-list" lists from plugin "jira" — list not shown']);
  });

  test("leaves a result with no display, an error, or a non-object untouched, handler not called", async () => {
    let called = false;
    const handler = () => ((called = true), { text: "X" });
    expect(await run(formatterPlugin(emitting({ ok: true, data: { raw: 1 } }), handler))).toEqual({ ok: true, data: { raw: 1 } });
    expect(await run(formatterPlugin(emitting({ ok: false, error: "boom" }), handler))).toEqual({ ok: false, error: "boom" });
    expect(await run(formatterPlugin(emitting("plain text"), handler))).toBe("plain text");
    // An error carrying a display is still an error: nothing to render.
    const failed = { ok: false, error: "boom", display: { type: "thing-list", items: [{ id: "A" }] } };
    expect(await run(formatterPlugin(emitting(failed), handler))).toEqual(failed);
    expect(called).toBe(false);
  });

  test("keeps every other field of a tool, and a tool without execute as it is", async () => {
    const toModelOutput = () => ({ type: "text" as const, value: "x" });
    const bare = { description: "No execute." } as unknown as Tool;
    const base = pluginWith({
      sessionTools: () => ({ find: { description: "Finds.", toModelOutput, execute: async () => ({ ok: true }) } as unknown as Tool, bare }),
    });
    const tools = (await formatterPlugin(base, () => ({ text: "R" })).build!(ctx)).sessionTools!(sctx);

    expect(tools.find!.description).toBe("Finds.");
    expect(tools.find!.toModelOutput).toBe(toModelOutput);
    expect(tools.bare).toBe(bare);
  });

  test("passes through every other contribution and top-level field", async () => {
    const guard = { statusLabel: () => "g", statusId: "g", shouldRun: () => false, run: async (text: string) => ({ text, outcome: "success" as const }) };
    const describers = { find: () => "Finding" };
    const base = pluginWith(
      { postTurnGuards: [guard], toolStatusDescribers: describers },
      { name: "jira", dependsOn: ["x"], systemPromptFragment: "frag", skills: [{ name: "s", description: "d", body: "b" }] },
    );
    const decorated = formatterPlugin(base, () => ({ text: "R" }));
    const built = (await decorated.build!(ctx));

    expect(decorated.name).toBe("jira");
    expect(decorated.dependsOn).toEqual(["x"]);
    expect(decorated.systemPromptFragment).toBe("frag");
    expect(decorated.skills).toEqual([{ name: "s", description: "d", body: "b" }]);
    expect(built.postTurnGuards).toEqual([guard]);
    expect(built.toolStatusDescribers).toBe(describers);
  });

  test("a plugin without tools, or without a build, gets none", async () => {
    expect((await formatterPlugin(pluginWith({}), () => ({ text: "R" })).build!(ctx)).sessionTools).toBeUndefined();
    expect((await formatterPlugin({ apiVersion: PLUGIN_API_VERSION, name: "n", description: "N." }, () => ({ text: "R" })).build!(ctx))).toEqual({});
  });

  test("keeps the plugin's name and description", () => {
    const wrapped = formatterPlugin(pluginWith({}), () => ({ text: "R" }));
    expect(wrapped.name).toBe("data");
    expect(wrapped.description).toBe("Reads data.");
  });

  test("passes the runtime context through to the inner build", async () => {
    let received: PluginRuntimeContext | undefined;
    const base: Plugin = { apiVersion: PLUGIN_API_VERSION, name: "n", description: "N.", build: (c) => ((received = c), {}) };
    (await formatterPlugin(base, () => ({ text: "R" })).build!(ctx));
    expect(received).toBe(ctx);
  });
});
