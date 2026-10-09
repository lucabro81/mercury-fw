import { describe, expect, test } from "bun:test";
import type { Tool } from "ai";
import { AS_MERCURY_NOTE, AS_MERCURY_SUFFIX, actingAsMercury } from "./act-as-mercury.ts";

function tool(description: string, result: unknown = { ok: true }) {
  const inputs: unknown[] = [];
  const t = {
    description,
    inputSchema: {} as never,
    execute: async (input: unknown) => {
      inputs.push(input);
      return result;
    },
  } as unknown as Tool;
  return { t, inputs };
}

const run = (t: Tool | undefined, input: unknown) => t!.execute!(input as never, {} as never);

describe("actingAsMercury", () => {
  test("the variant beside the person's own gets another name and says whose identity it runs with", async () => {
    const { t, inputs } = tool("Runs a jira command.");
    const logs: string[] = [];
    const out = actingAsMercury({ jiraCommand: t }, { plugin: "jira", personKey: "people:alice", rename: true, log: (m) => logs.push(m) });
    expect(Object.keys(out)).toEqual([`jiraCommand${AS_MERCURY_SUFFIX}`]);
    const variant = out[`jiraCommand${AS_MERCURY_SUFFIX}`];
    expect(variant?.description).toBe(`${AS_MERCURY_NOTE} Runs a jira command.`);
    expect(await run(variant, { command: "jira issue get A-1" })).toEqual({ ok: true });
    expect(inputs).toEqual([{ command: "jira issue get A-1" }]);
  });

  test("a plugin acting as Mercury keeps its tools' names, and says whose identity they run with", () => {
    const { t } = tool("Looks a user up.");
    const out = actingAsMercury({ adminCommand: t }, { plugin: "admin", personKey: "people:alice", rename: false, log: () => {} });
    expect(Object.keys(out)).toEqual(["adminCommand"]);
    expect(out.adminCommand?.description).toBe(`${AS_MERCURY_NOTE} Looks a user up.`);
  });

  // Accountability: a service only ever sees Mercury, so who asked has to be
  // written down on Mercury's side.
  test("every call is logged with the person, the plugin and what ran", async () => {
    const { t } = tool("d");
    const logs: string[] = [];
    const out = actingAsMercury({ adminCommand: t }, { plugin: "admin", personKey: "people:alice", rename: false, log: (m) => logs.push(m) });
    await run(out.adminCommand, { command: "atlassian-admin user get --account-id 1" });
    expect(logs).toEqual([
      '[act-as-self] people:alice ran adminCommand of plugin "admin" as Mercury: {"command":"atlassian-admin user get --account-id 1"}',
    ]);
  });

  test("a tool without execute is passed through renamed, with nothing to log", () => {
    const t = { description: "d", inputSchema: {} as never } as unknown as Tool;
    const out = actingAsMercury({ x: t }, { plugin: "p", personKey: "k", rename: true, log: () => {} });
    expect(out[`x${AS_MERCURY_SUFFIX}`]?.execute).toBeUndefined();
  });
});
