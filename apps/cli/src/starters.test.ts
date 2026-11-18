/**
 * The starters `mfw create` offers are hand-written, like the catalog: these
 * tests keep each one honest against the catalog it builds on and against the
 * tools its e2e test checks, so a renamed plugin or tool fails here instead
 * of in an app someone just created.
 */
import { describe, expect, test } from "bun:test";
import { CATALOG } from "./catalog.ts";
import { findStarter, keepStarter, STARTERS } from "./starters.ts";

/** The plugins that ship a skill: only their starters' tests may check it's loaded. */
const SKILLS = new Set(["jira", "confluence"]);

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
    const skills = starter.plugins.some((p) => SKILLS.has(p)) ? ["read_skill"] : [];
    const allowed = new Set([...skills, ...starter.plugins.flatMap((p) => TOOLS[p] ?? [])]);
    const named = [
      ...[...starter.e2e.matchAll(/expect\.(?:call|everyCall)\("([^"]+)"/g)].map((m) => m[1]!),
      ...[...starter.e2e.matchAll(/\.tool === "([^"]+)"/g)].map((m) => m[1]!),
    ];
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(allowed).toContain(tool);
  });

  test.each(STARTERS.map((s) => [s.id, s] as const))("%s's README section opens with its title", (_id, starter) => {
    expect(starter.readme).toStartWith(`## ${starter.title}\n`);
    expect(starter.readme).toEndWith("\n");
  });
});

describe("keepStarter", () => {
  const jira = findStarter("jira-assistant")!;

  test("keeps the starter when its plugins are among those picked", () => {
    expect(keepStarter(jira, ["jira", "bitbucket"])).toEqual({ starter: jira });
  });

  // Its e2e test calls its plugins: without them it's left out, saying why.
  test("leaves it out, with a warning, when one of its plugins isn't picked", () => {
    expect(keepStarter(jira, ["bitbucket"])).toEqual({ warning: "The jira-assistant starter is left out: it needs the jira plugin" });
  });

  test("no starter, nothing to keep or say", () => {
    expect(keepStarter(undefined, ["jira"])).toEqual({});
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
