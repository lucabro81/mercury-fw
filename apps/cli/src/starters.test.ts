/**
 * The starters `mfw create` offers are hand-written, like the catalog: these
 * tests keep each one honest against the catalog it builds on and against the
 * tools its e2e test checks, so a renamed plugin or tool fails here instead
 * of in an app someone just created.
 */
import { describe, expect, test } from "bun:test";
import { CATALOG } from "./catalog.ts";
import { findStarter, STARTERS } from "./starters.ts";

/** The tools each plugin a starter can use contributes, as its e2e test may name them. */
const TOOLS: Record<string, string[]> = {
  jira: ["jiraCommand"],
  confluence: ["confluenceCommand"],
  "web-search": ["web_search", "web_fetch"],
};

describe("STARTERS", () => {
  test("knowledge-base, jira-assistant and web-researcher, in that order", () => {
    expect(STARTERS.map((s) => s.id)).toEqual(["knowledge-base", "jira-assistant", "web-researcher"]);
  });

  test.each(STARTERS.map((s) => [s.id, s] as const))("%s builds on the catalog's tool plugins", (_id, starter) => {
    const tools = CATALOG.filter((e) => e.kind === "tool").map((e) => e.id);
    expect(starter.plugins.length).toBeGreaterThan(0);
    for (const plugin of starter.plugins) expect(tools).toContain(plugin);
  });

  test.each(STARTERS.map((s) => [s.id, s] as const))("%s has a title, a one-line summary and a role that follows \"You are <name>, \"", (_id, starter) => {
    expect(starter.title.length).toBeGreaterThan(0);
    expect(starter.summary).not.toContain("\n");
    expect(starter.role).toMatch(/^[a-z]/);
    expect(starter.role).not.toMatch(/\.$/);
  });

  test.each(STARTERS.map((s) => [s.id, s] as const))("%s's e2e test needs its plugins and checks only their tools", (_id, starter) => {
    expect(starter.e2e).toContain('import { e2e } from "@mercury-fw/cli/e2e";');
    expect(starter.e2e).toContain(`plugins: ${JSON.stringify(starter.plugins)},`);
    const allowed = new Set(["read_skill", ...starter.plugins.flatMap((p) => TOOLS[p] ?? [])]);
    const named = [...starter.e2e.matchAll(/expect\.(?:call|everyCall)\("([^"]+)"/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(allowed).toContain(tool);
  });

  test.each(STARTERS.map((s) => [s.id, s] as const))("%s's README section opens with its title", (_id, starter) => {
    expect(starter.readme).toStartWith(`## ${starter.title}\n`);
    expect(starter.readme).toEndWith("\n");
  });
});

describe("findStarter", () => {
  test("returns the starter with that id", () => {
    expect(findStarter("jira-assistant")?.plugins).toEqual(["jira"]);
  });

  test("returns undefined for an id there's none of", () => {
    expect(findStarter("slack-bot")).toBeUndefined();
  });
});
