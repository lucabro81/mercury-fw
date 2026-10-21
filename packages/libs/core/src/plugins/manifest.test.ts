import { describe, it, expect } from "bun:test";
import { buildPluginManifest } from "./manifest.ts";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";

/**
 * The manifest reports what an instance actually loaded — for the HTTP read
 * surface's introspection. It distinguishes a rich plugin (skills + build) from
 * a minimal one, marks which activated (from the loader's activated set, since a
 * plugin no longer exposes a central config), and always reports the core's
 * apiVersion so a reader can spot a plugin/core version skew. The active CLIs
 * are the activated plugins plus the file-based CLIs (the residual).
 */
describe("buildPluginManifest", () => {
  it("summarizes each plugin, the active CLIs, and the core apiVersion", () => {
    const jira: Plugin = {
      apiVersion: PLUGIN_API_VERSION,
      name: "jira",
      description: "Reads Jira issues.",
      skills: [{ name: "jira", description: "how to jira", body: "..." }],
      build: () => ({}),
    };
    const bitbucket: Plugin = { apiVersion: PLUGIN_API_VERSION, name: "bitbucket", description: "Reads pull requests." };

    // jira activated, bitbucket didn't; google-chat is a file-based CLI.
    const manifest = buildPluginManifest([jira, bitbucket], ["jira"], ["google-chat"], jira.skills!);

    expect(manifest.coreApiVersion).toBe(PLUGIN_API_VERSION);
    expect(manifest.activeClis).toEqual(["google-chat", "jira"]);
    expect(manifest.skills).toEqual([{ name: "jira", description: "how to jira" }]);
    expect(manifest.plugins).toEqual([
      { name: "jira", apiVersion: PLUGIN_API_VERSION, active: true, skills: ["jira"], hasBuild: true },
      { name: "bitbucket", apiVersion: PLUGIN_API_VERSION, active: false, skills: [], hasBuild: false },
    ]);
  });
});
