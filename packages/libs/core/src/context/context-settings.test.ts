import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextLayer, Plugin } from "@mercury-fw/plugin-types";
import type { LoadedPlugin } from "../plugins/plugin-loader.ts";
import type { TraceInput } from "../traces/tracer.ts";
import { resolveContext, type ResolvedContext } from "./context.ts";
import { createContextSettings } from "./context-settings.ts";

/** A declared plugin and its loaded counterpart, with a layer of `scope` declaring `knobs`. */
function plugin(name: string, scope: "session" | "turn", knobs?: ContextLayer["knobs"]): { declared: Plugin; loaded: LoadedPlugin } {
  const declared = { apiVersion: 6, name, description: name } as Plugin;
  const context: ContextLayer = { scope, build: async () => [], ...(knobs === undefined ? {} : { knobs }) };
  return { declared, loaded: { name, description: name, actsAs: "anyone", skills: [], source: declared, context } };
}

const wiki = plugin("wiki", "session", { depth: { type: "integer", default: 1, description: "How deep", min: 1, max: 4 } });
const rag = plugin("rag", "turn", {
  topK: { type: "integer", default: 5, description: "How many hits", min: 1, max: 20 },
  mode: { type: "enum", default: "fast", description: "How to search", values: ["fast", "deep"] },
});
const notes = plugin("notes", "turn");

/** The instance's context, as resolved at startup: `default` with every layer, `premium` for `paid`. */
function resolved(): ResolvedContext {
  const all = [wiki, rag, notes];
  return resolveContext(
    {
      profiles: {
        default: { layers: [wiki.declared, rag.declared, notes.declared], budget: { maxChars: 1000 } },
        premium: { layers: [rag.declared], budget: { maxChars: 5000 } },
      },
      assign: { premium: ["paid", "vip"] },
    },
    { declared: all.map((p) => p.declared), loaded: all.map((p) => p.loaded), log: () => {} },
  )!;
}

let dir: string;
let logs: string[];
let events: TraceInput[];
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-settings-"));
  logs = [];
  events = [];
  clock = Date.parse("2026-11-12T10:00:00.000Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Settings over `context` (a fresh one by default) in the test's folder. */
function settings(context: ResolvedContext = resolved()) {
  return createContextSettings({
    resolved: context,
    dataPath: dir,
    log: (m) => logs.push(m),
    emit: (e) => events.push(e),
    now: () => new Date(clock),
  });
}

describe("createContextSettings: view", () => {
  it("shows every profile as it runs, default first: the roles it's given to, its budget, its layers in order with their knobs' specs and values", () => {
    expect(settings().view()).toEqual({
      profiles: [
        {
          name: "default",
          assignedTo: [],
          maxChars: 1000,
          layers: [
            { plugin: "wiki", scope: "session", knobs: [{ name: "depth", type: "integer", default: 1, description: "How deep", min: 1, max: 4, value: 1 }] },
            {
              plugin: "rag",
              scope: "turn",
              knobs: [
                { name: "topK", type: "integer", default: 5, description: "How many hits", min: 1, max: 20, value: 5 },
                { name: "mode", type: "enum", default: "fast", description: "How to search", values: ["fast", "deep"], value: "fast" },
              ],
            },
            { plugin: "notes", scope: "turn", knobs: [] },
          ],
        },
        {
          name: "premium",
          assignedTo: ["paid", "vip"],
          maxChars: 5000,
          layers: [
            {
              plugin: "rag",
              scope: "turn",
              knobs: [
                { name: "topK", type: "integer", default: 5, description: "How many hits", min: 1, max: 20, value: 5 },
                { name: "mode", type: "enum", default: "fast", description: "How to search", values: ["fast", "deep"], value: "fast" },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("createContextSettings: update", () => {
  it("changes a profile's budget, order and knobs in the running context, and answers with the profile as it now runs", () => {
    const context = resolved();
    const outcome = settings(context).update("u:admin", "default", {
      maxChars: 800,
      order: ["notes", "wiki", "rag"],
      knobs: { rag: { topK: 9, mode: "deep" } },
    });
    const profile = context.profiles.get("default")!;
    expect(profile.maxChars).toBe(800);
    expect(profile.layers.map((p) => p.name)).toEqual(["notes", "wiki", "rag"]);
    expect(profile.knobs.get("rag")).toEqual({ topK: 9, mode: "deep" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.maxChars).toBe(800);
    expect(outcome.value.layers.map((l) => l.plugin)).toEqual(["notes", "wiki", "rag"]);
    expect(outcome.value.layers[2]!.knobs.map((k) => [k.name, k.value])).toEqual([
      ["topK", 9],
      ["mode", "deep"],
    ]);
  });

  it("puts a knob back to its default with null, and leaves what the change doesn't name as it was", () => {
    const context = resolved();
    const s = settings(context);
    s.update("u:admin", "default", { knobs: { rag: { topK: 9, mode: "deep" } } });
    s.update("u:admin", "default", { knobs: { rag: { topK: null } } });
    expect(context.profiles.get("default")!.knobs.get("rag")).toEqual({ mode: "deep" });
    expect(context.profiles.get("default")!.maxChars).toBe(1000);
  });

  it("refuses a profile that doesn't exist", () => {
    expect(settings().update("u:admin", "gold", { maxChars: 10 })).toEqual({ ok: false, status: "notFound", error: 'there\'s no context profile "gold"' });
  });

  it("refuses a change that doesn't fit, naming why, and changes nothing of it", () => {
    const context = resolved();
    const s = settings(context);
    const refusals: Array<[unknown, string]> = [
      [null, "a change is an object with maxChars, order or knobs"],
      [[], "a change is an object with maxChars, order or knobs"],
      [{}, "the change changes nothing"],
      [{ budget: 3 }, 'a change has no field "budget"'],
      [{ maxChars: -1 }, "maxChars must be a whole number from 0 up"],
      [{ maxChars: 1.5 }, "maxChars must be a whole number from 0 up"],
      [{ maxChars: "10" }, "maxChars must be a whole number from 0 up"],
      [{ order: ["rag", "wiki"] }, "order must list the profile's layers, each once: wiki, rag, notes"],
      [{ order: ["rag", "wiki", "wiki"] }, "order must list the profile's layers, each once: wiki, rag, notes"],
      [{ order: ["rag", "wiki", "jira"] }, "order must list the profile's layers, each once: wiki, rag, notes"],
      [{ order: "rag" }, "order must list the profile's layers, each once: wiki, rag, notes"],
      [{ knobs: [] }, "knobs must be an object, by plugin"],
      [{ knobs: { jira: { x: 1 } } }, 'the profile has no layer of "jira"'],
      [{ knobs: { rag: 3 } }, 'knobs of "rag" must be an object, by knob'],
      [{ knobs: { rag: { depth: 2 } } }, 'the layer of "rag" has no knob "depth"'],
      [{ knobs: { rag: { topK: 0 } } }, 'knob "topK" of "rag" must be 1 or more'],
      [{ knobs: { rag: { mode: "slow" } } }, 'knob "mode" of "rag" must be one of fast, deep'],
      [{ maxChars: 10, knobs: { rag: { topK: 99 } } }, 'knob "topK" of "rag" must be 20 or less'],
    ];
    for (const [change, error] of refusals) {
      expect([change, s.update("u:admin", "default", change as never)]).toEqual([change, { ok: false, status: "invalid", error }]);
    }
    const profile = context.profiles.get("default")!;
    expect([profile.maxChars, profile.layers.map((p) => p.name), profile.knobs]).toEqual([1000, ["wiki", "rag", "notes"], new Map()]);
    expect(s.changes(10)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("records each change, with who, when, which profile, and what it changed before and after (a knob at its default as null)", () => {
    const s = settings();
    s.update("u:admin", "default", { maxChars: 800, knobs: { rag: { topK: 9 } } });
    clock += 60_000;
    s.update("u:root", "default", { order: ["rag", "wiki", "notes"], knobs: { rag: { topK: null } } });
    expect(s.changes(10)).toEqual([
      {
        at: "2026-11-12T10:01:00.000Z",
        by: "u:root",
        profile: "default",
        before: { order: ["wiki", "rag", "notes"], knobs: { rag: { topK: 9 } } },
        after: { order: ["rag", "wiki", "notes"], knobs: { rag: { topK: null } } },
      },
      {
        at: "2026-11-12T10:00:00.000Z",
        by: "u:admin",
        profile: "default",
        before: { maxChars: 1000, knobs: { rag: { topK: null } } },
        after: { maxChars: 800, knobs: { rag: { topK: 9 } } },
      },
    ]);
    expect(s.changes(1).map((c) => c.by)).toEqual(["u:root"]);
  });

  it("emits context.changed for each change: the person and the profile, the fields and knobs changed, the values only at the args level", () => {
    settings().update("u:admin", "premium", { maxChars: 4000, knobs: { rag: { mode: "deep" } } });
    expect(events).toEqual([
      {
        kind: "context.changed",
        person: "u:admin",
        profile: "premium",
        changed: ["maxChars", "knobs.rag.mode"],
        args: { before: { maxChars: 5000, knobs: { rag: { mode: null } } }, after: { maxChars: 4000, knobs: { rag: { mode: "deep" } } } },
      },
    ]);
  });
});

describe("createContextSettings: across restarts", () => {
  it("keeps the changes in the data folder and applies them at the next start", () => {
    settings().update("u:admin", "default", { maxChars: 800, order: ["notes", "rag", "wiki"], knobs: { rag: { mode: "deep" }, wiki: { depth: 3 } } });
    const again = resolved();
    const s = settings(again);
    const profile = again.profiles.get("default")!;
    expect([profile.maxChars, profile.layers.map((p) => p.name)]).toEqual([800, ["notes", "rag", "wiki"]]);
    expect([...profile.knobs]).toEqual([
      ["rag", { mode: "deep" }],
      ["wiki", { depth: 3 }],
    ]);
    expect(s.changes(10)).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("ignores at startup, with a line each, a kept value that no longer fits the config or the plugins, and applies the rest", () => {
    writeFileSync(
      join(dir, "context-settings.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          default: { maxChars: 700, order: ["rag", "wiki"], knobs: { rag: { topK: 50, mode: "deep", gone: 1 }, jira: { x: 1 } } },
          premium: { maxChars: -3 },
          gold: { maxChars: 10 },
        },
      }),
    );
    const again = resolved();
    settings(again);
    const profile = again.profiles.get("default")!;
    expect([profile.maxChars, profile.layers.map((p) => p.name), [...profile.knobs]]).toEqual([700, ["wiki", "rag", "notes"], [["rag", { mode: "deep" }]]]);
    expect(again.profiles.get("premium")!.maxChars).toBe(5000);
    expect(logs).toEqual([
      '[context] kept order of profile "default" ignored: order must list the profile\'s layers, each once: wiki, rag, notes',
      '[context] kept knob "topK" of "rag" in profile "default" ignored: knob "topK" of "rag" must be 20 or less',
      '[context] kept knob "gone" of "rag" in profile "default" ignored: the layer of "rag" has no knob "gone"',
      '[context] kept knobs of "jira" in profile "default" ignored: the profile has no layer of "jira"',
      '[context] kept maxChars of profile "premium" ignored: maxChars must be a whole number from 0 up',
      '[context] kept settings of profile "gold" ignored: there\'s no context profile "gold"',
    ]);
  });

  it("applies nothing from a settings file it can't read, and refuses to write over it", () => {
    writeFileSync(join(dir, "context-settings.json"), "{ not json");
    const s = settings();
    expect(logs).toEqual([`[context] can't read the context settings in ${join(dir, "context-settings.json")}, none applied: not JSON`]);
    expect(() => s.update("u:admin", "default", { maxChars: 10 })).toThrow("fix or remove the file first");
    expect(readFileSync(join(dir, "context-settings.json"), "utf8")).toBe("{ not json");
  });

  it("skips a change-log line it can't read", () => {
    const s = settings();
    s.update("u:admin", "default", { maxChars: 800 });
    writeFileSync(join(dir, "context-changes.jsonl"), `${readFileSync(join(dir, "context-changes.jsonl"), "utf8")}garbage\n`);
    expect(s.changes(10).map((c) => c.by)).toEqual(["u:admin"]);
  });
});
