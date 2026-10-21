import { describe, expect, test } from "bun:test";
import type { Tool } from "ai";
import type { SessionToolContext } from "@mercury-fw/plugin-types";
import type { LoadedPlugin } from "./plugin-loader.ts";
import { ACT_AS_SELF, offeringFor } from "./offering.ts";
import { AS_SELF_NOTE } from "./act-as-self.ts";
import { buildOfferedTools } from "./offered-tools.ts";

/** A plugin whose one tool records the context it was built with. */
function plugin(name: string, actsAs: "person" | "mercury", built: SessionToolContext[]): LoadedPlugin {
  return {
    name,
    description: `what ${name} does`,
    actsAs,
    skills: [],
    bundle: {
      name,
      login: { start: async () => ({ ok: false, error: "x" }), complete: async () => ({ ok: true }) },
      build: (ctx) => {
        built.push(ctx);
        return { [`${name}Command`]: { description: `${name} tool`, inputSchema: {} as never, execute: async () => ({ ok: true }) } as unknown as Tool };
      },
    },
  };
}

const context = { sessionKey: "s", t: (key: string) => key, stageConfirmation: async () => "t", stashDisplay: () => "d" };

function setup(roles: string[], operator = false) {
  const built: SessionToolContext[] = [];
  const logs: string[] = [];
  const logins: Array<[string, string]> = [];
  const plugins = [plugin("jira", "person", built), plugin("admin", "mercury", built), { name: "prompt-only", description: "Only adds to the prompt.", actsAs: "person", skills: [] } as LoadedPlugin];
  const who = { person: { key: "people:alice", roles }, operator };
  const result = buildOfferedTools(offeringFor(plugins, { roles, operator }), who, {
    context,
    requireLogin: async (service, _login, personKey) => {
      logins.push([service, personKey]);
      return { ok: false, error: "no channel" };
    },
    log: (m) => logs.push(m),
  });
  return { ...result, built, logs, logins };
}

describe("buildOfferedTools", () => {
  test("a person without the permission gets the person-acting tools, built for them", () => {
    const { tools, built, hasCliTool } = setup([]);
    expect(Object.keys(tools)).toEqual(["jiraCommand"]);
    expect(built.map((c) => c.person)).toEqual([{ key: "people:alice" }]);
    expect(hasCliTool).toBe(true);
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

  test("no tool-contributing plugin offered: no CLI tool", () => {
    const who = { person: { key: "k", roles: [] }, operator: false };
    const plugins = [{ name: "prompt-only", description: "Only adds to the prompt.", actsAs: "person", skills: [] } as LoadedPlugin];
    expect(buildOfferedTools(offeringFor(plugins, { roles: [], operator: false }), who, { context, requireLogin: async () => ({ ok: false, error: "" }), log: () => {} })).toEqual({
      tools: {},
      hasCliTool: false,
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
