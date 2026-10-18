import { describe, expect, test } from "bun:test";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { watchBuild } from "./build-watch.ts";

type Build = NonNullable<Plugin["build"]>;
const ctx = { env: {}, log: () => {} } as unknown as Parameters<Build>[0];

function plugin(build?: Build): Plugin {
  return { apiVersion: PLUGIN_API_VERSION, name: "jira", actsAs: "person", ...(build === undefined ? {} : { build }) } as unknown as Plugin;
}

// Guards against the core's loader skipping a plugin whose build() throws
// (fail-soft by design): tasks would then run without the plugin's tool, and
// score the skill on a model that couldn't follow it.
describe("watchBuild", () => {
  test("a build that throws is remembered and still throws, so the core skips the plugin as usual", () => {
    const watched = watchBuild(
      plugin(() => {
        throw new Error("JIRA_SITE_URL is not set");
      }),
    );
    expect(() => watched.plugin.build?.(ctx)).toThrow("JIRA_SITE_URL is not set");
    expect(watched.failure()).toBe("the jira plugin didn't load: JIRA_SITE_URL is not set");
  });

  test("a build that works returns what it built and leaves no failure", () => {
    const built = { postProcess: [] } as unknown as ReturnType<Build>;
    const watched = watchBuild(plugin(() => built));
    expect(watched.plugin.build?.(ctx)).toBe(built);
    expect(watched.failure()).toBeUndefined();
  });

  test("a build the core never called is a failure: the plugin didn't load", () => {
    expect(watchBuild(plugin(() => ({}) as ReturnType<Build>)).failure()).toBe("the jira plugin didn't load: its build was never called");
  });

  test("a plugin without a build has nothing to fail", () => {
    const original = plugin();
    const watched = watchBuild(original);
    expect(watched.plugin).toBe(original);
    expect(watched.failure()).toBeUndefined();
  });

  test("leaves the rest of the plugin as it was", () => {
    const original = plugin(() => ({}) as ReturnType<Build>);
    const watched = watchBuild(original);
    expect(watched.plugin.name).toBe("jira");
    expect(watched.plugin).not.toBe(original);
    expect(original.build).not.toBe(watched.plugin.build);
  });
});
