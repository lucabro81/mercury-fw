import { describe, expect, test } from "bun:test";
import type { Tool } from "ai";
import type { Plugin, SessionToolContext } from "@mercury-fw/plugin-types";
import type { LoadedPlugin } from "./plugin-loader.ts";
import { ACT_AS_SELF, offeringFor } from "./offering.ts";
import { AS_SELF_NOTE } from "./act-as-self.ts";
import { buildOfferedTools } from "./offered-tools.ts";
import { createCliTool, type CliConfig } from "@mercury-fw/cli-engine";
import { createDisplayStore } from "../tools/display-store.ts";
import { createOutputProbe } from "../session/turn-output.ts";

/** A plugin whose one tool records the context it was built with. */
function plugin(name: string, actsAs: "person" | "mercury", built: SessionToolContext[]): LoadedPlugin {
  return {
    name,
    description: `what ${name} does`,
    actsAs,
    source: { name } as Plugin,
    skills: [],
    bundle: {
      name,
      login: { start: async () => ({ ok: false, error: "x" }), complete: async () => ({ ok: true }) },
      build: (ctx) => {
        built.push(ctx);
        return {
          [`${name}Command`]: {
            description: `${name} tool`,
            inputSchema: {} as never,
            execute: async () => ({ ok: true, display: { type: "list", items: [`${name} list`] } }),
          } as unknown as Tool,
        };
      },
    },
  };
}

const context = { sessionKey: "s", t: (key: string) => key, stageConfirmation: async () => "t", stashDisplay: () => "d" };

function setup(roles: string[], operator = false) {
  const built: SessionToolContext[] = [];
  const stashed: Array<{ artifact: string; label: string; show: boolean }> = [];
  const logs: string[] = [];
  const logins: Array<[string, string]> = [];
  const plugins = [plugin("jira", "person", built), plugin("admin", "mercury", built), { name: "prompt-only", description: "Only adds to the prompt.", actsAs: "person", skills: [], source: { name: "prompt-only" } as Plugin } satisfies LoadedPlugin];
  const who = { person: { key: "people:alice", roles }, operator };
  const result = buildOfferedTools(offeringFor(plugins, { roles, operator }), who, {
    context,
    requireLogin: async (service, _login, personKey) => {
      logins.push([service, personKey]);
      return { ok: false, error: "no channel" };
    },
    log: (m) => logs.push(m),
    stashDisplay: (artifact, label, opts) => (stashed.push({ artifact, label, show: opts.show }), `d${stashed.length}`),
  });
  return { ...result, built, logs, logins, stashed };
}

describe("buildOfferedTools", () => {
  test("a person without the permission gets the person-acting tools, built for them", () => {
    const { tools, built, hasPluginTools } = setup([]);
    expect(Object.keys(tools)).toEqual(["jiraCommand"]);
    expect(built.map((c) => c.person)).toEqual([{ key: "people:alice" }]);
    expect(hasPluginTools).toBe(true);
  });

  // #375: the core strips and stashes every plugin tool's display, not the
  // CLI engine alone, so a typed tool's never reaches the model either.
  test("every tool's display is stashed for the session and only its ref reaches the model, the variants' too", async () => {
    const { tools, stashed } = setup([ACT_AS_SELF]);
    expect(await tools.jiraCommand!.execute!({ q: 1 } as never, {} as never)).toEqual({ ok: true, displayRef: "d1" });
    expect(await tools.jiraCommandAsSelf!.execute!({ q: 2 } as never, {} as never)).toEqual({ ok: true, displayRef: "d2" });
    expect(stashed).toEqual([
      { artifact: "jira list", label: 'jiraCommand {"q":1} (1 item)', show: false },
      { artifact: "jira list", label: 'jiraCommandAsSelf {"q":2} (1 item)', show: false },
    ]);
  });

  test("with the permission: the variant built with no person, renamed and described; the Mercury plugin built with no person", () => {
    const { tools, built } = setup([ACT_AS_SELF]);
    expect(Object.keys(tools)).toEqual(["jiraCommand", "jiraCommandAsSelf", "adminCommand"]);
    expect(built.map((c) => c.person)).toEqual([{ key: "people:alice" }, null, null]);
    expect(tools.jiraCommand?.description).toBe("jira tool");
    expect(tools.jiraCommandAsSelf?.description).toBe(`${AS_SELF_NOTE} jira tool`);
    expect(tools.adminCommand?.description).toBe(`${AS_SELF_NOTE} admin tool`);
  });

  test("a call made as Mercury for a person is logged with who asked; one made as the person isn't", async () => {
    const { tools, logs } = setup([ACT_AS_SELF]);
    await tools.jiraCommand!.execute!({ command: "jira x" } as never, {} as never);
    await tools.jiraCommandAsSelf!.execute!({ command: "jira y" } as never, {} as never);
    await tools.adminCommand!.execute!({ command: "admin z" } as never, {} as never);
    expect(logs).toEqual([
      '[act-as-self] people:alice ran jiraCommand of plugin "jira" as Mercury: {"command":"jira y"}',
      '[act-as-self] people:alice ran adminCommand of plugin "admin" as Mercury: {"command":"admin z"}',
    ]);
  });

  test("the operator gets every tool raw, as Mercury, nothing logged", async () => {
    const { tools, built, logs } = setup([], true);
    expect(Object.keys(tools)).toEqual(["jiraCommand", "adminCommand"]);
    expect(built.map((c) => c.person)).toEqual([null, null]);
    expect(tools.jiraCommand?.description).toBe("jira tool");
    await tools.adminCommand!.execute!({} as never, {} as never);
    expect(logs).toEqual([]);
  });

  // Acting as Mercury is never a way into the person's login: only a tool
  // built for the person can ask for one.
  test("requireLogin starts the person's login only for a tool acting as them", async () => {
    const { built, logins } = setup([ACT_AS_SELF]);
    expect(await built[0]!.requireLogin()).toEqual({ ok: false, error: "no channel" });
    expect(logins).toEqual([["jira", "people:alice"]]);
    expect(await built[1]!.requireLogin()).toMatchObject({ ok: false });
    expect(await built[2]!.requireLogin()).toMatchObject({ ok: false });
    expect(logins).toHaveLength(1);
  });

  test("no tool-contributing plugin offered: no plugin tools", () => {
    const who = { person: { key: "k", roles: [] }, operator: false };
    const plugins = [{ name: "prompt-only", description: "Only adds to the prompt.", actsAs: "person", skills: [], source: { name: "prompt-only" } as Plugin } satisfies LoadedPlugin];
    expect(buildOfferedTools(offeringFor(plugins, { roles: [], operator: false }), who, { context, requireLogin: async () => ({ ok: false, error: "" }), log: () => {}, stashDisplay: () => "d" })).toEqual({
      tools: {},
      hasPluginTools: false,
    });
  });
});

describe("buildOfferedTools: a plugin that acts as no one", () => {
  function setupAnyone(operator: boolean) {
    const built: SessionToolContext[] = [];
    const search = { ...plugin("search", "person", built), actsAs: "anyone" } as LoadedPlugin;
    const who = { person: { key: operator ? "operator:terminal" : "people:alice", roles: [ACT_AS_SELF] }, operator };
    const result = buildOfferedTools(offeringFor([search], { roles: [ACT_AS_SELF], operator }), who, {
      context,
      requireLogin: async () => ({ ok: false, error: "no channel" }),
      log: () => {},
      stashDisplay: () => "d",
    });
    return { ...result, built };
  }

  test("its tools are built for the person the turn is for, under their own names, never described as Mercury", () => {
    const { tools, built } = setupAnyone(false);
    expect(Object.keys(tools)).toEqual(["searchCommand"]);
    expect(built.map((c) => c.person)).toEqual([{ key: "people:alice" }]);
    expect(tools.searchCommand?.description).toBe("search tool");
  });

  test("on the terminal its tools get the operator's key", () => {
    const { built } = setupAnyone(true);
    expect(built.map((c) => c.person)).toEqual([{ key: "operator:terminal" }]);
  });

  test("asking it for a login starts none", async () => {
    const { built } = setupAnyone(false);
    expect(await built[0]!.requireLogin()).toEqual({ ok: false, error: "search says the user isn't logged in, and it has no way to log anyone in." });
  });
});

// #375 review: each layer is tested alone; this runs a real CLI tool through
// the core's display channel into the display store, so a list is stashed
// exactly once and the model gets only its ref.
describe("buildOfferedTools: a real CLI tool through the display channel", () => {
  test("stashes the rendered list once, under the tool's label, and hands back only the ref", async () => {
    const store = createDisplayStore({ refFn: () => "d1" });
    const config: CliConfig = { allowedPrefixes: [{ prefix: ["issue", "search"], confirm: false, mutating: false }] };
    const cli: LoadedPlugin = {
      name: "jira",
      description: "Reads Jira.",
      actsAs: "anyone",
      source: { name: "jira" } as Plugin,
      skills: [],
      bundle: {
        name: "jira",
        build: (sctx) =>
          ({
            jiraCommand: createCliTool(async () => ({ ok: true, data: { issues: 1 } }), { jira: config }, {
              stageConfirmation: sctx.stageConfirmation,
              t: sctx.t,
              postProcess: (_c, r) => (r.ok ? { ...r, display: { type: "issue-list", items: ["MER-1"] } } : r),
            }).runCommand,
          }) as Record<string, Tool>,
      },
    };
    const who = { person: { key: "people:alice", roles: [] }, operator: false };
    const { tools } = buildOfferedTools(offeringFor([cli], { roles: [], operator: false }), who, {
      context,
      requireLogin: async () => ({ ok: false, error: "" }),
      log: () => {},
      stashDisplay: (artifact, label, opts) => store.stash("s", artifact, label, opts),
    });

    const output = await tools.jiraCommand!.execute!({ command: "jira issue search" } as never, {} as never);

    expect(output).toEqual({ ok: true, data: { issues: 1 }, displayRef: "d1" });
    store.surface("s", "d1");
    expect(store.takeSurfaced("s")).toEqual(["MER-1"]);
    expect(store.shown("s")).toEqual([{ ref: "d1", label: 'jiraCommand {"command":"jira issue search"} (1 item)' }]);
  });
});

describe("buildOfferedTools: the tool that ends the turn (#403)", () => {
  test("the probe sees the whole result, display included, while the model's copy goes through the display channel", async () => {
    const probe = createOutputProbe();
    const built: SessionToolContext[] = [];
    const { tools } = buildOfferedTools(offeringFor([plugin("jira", "person", built)], { roles: [], operator: false }), { person: { key: "people:alice", roles: [] }, operator: false }, {
      context,
      requireLogin: async () => ({ ok: false, error: "x" }),
      log: () => {},
      stashDisplay: () => "d1",
      outputTool: { plugin: "jira", tool: "jiraCommand", probe },
    });
    const seen = await (tools.jiraCommand!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {});
    expect(probe.offered).toBe(true);
    expect(probe.accepted).toEqual({ value: { ok: true, display: { type: "list", items: ["jira list"] } } });
    expect(seen).toEqual({ ok: true, displayRef: "d1" });
  });

  test("another plugin's tool of the same name isn't the output tool", () => {
    const probe = createOutputProbe();
    buildOfferedTools(offeringFor([plugin("jira", "person", [])], { roles: [], operator: false }), { person: { key: "people:alice", roles: [] }, operator: false }, {
      context,
      requireLogin: async () => ({ ok: false, error: "x" }),
      log: () => {},
      stashDisplay: () => "d1",
      outputTool: { plugin: "other", tool: "jiraCommand", probe },
    });
    expect(probe.offered).toBe(false);
  });

  test("a plugin not offered to the person leaves the tool unoffered", () => {
    const probe = createOutputProbe();
    buildOfferedTools(offeringFor([plugin("admin", "mercury", [])], { roles: [], operator: false }), { person: { key: "people:alice", roles: [] }, operator: false }, {
      context,
      requireLogin: async () => ({ ok: false, error: "x" }),
      log: () => {},
      stashDisplay: () => "d1",
      outputTool: { plugin: "admin", tool: "adminCommand", probe },
    });
    expect(probe.offered).toBe(false);
  });
});
