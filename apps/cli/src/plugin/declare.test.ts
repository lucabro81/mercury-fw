/**
 * Declaring a new plugin in the app: its package in `package.json` (and in
 * `trustedDependencies` when it has a postinstall), and in
 * `mercury.config.ts` its import and its value where the config takes it, but
 * only when that place is found exactly once and isn't taken: otherwise the
 * file is left as it is and the lines to add come back to be printed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { addToManifest, declareInConfig, type DeclareInput } from "./declare.ts";

/** The config a new app with nothing chosen gets. */
const NEW_APP = readFileSync(new URL("../__fixtures__/render/empty.mercury.config.ts.golden", import.meta.url), "utf-8");

/** A plugin named guest-wifi of `kind`, from the app's workspace. */
function plugin(kind: DeclareInput["kind"], exportName = "guestWifiPlugin"): DeclareInput {
  return { kind, exportName, packageName: "@my-agent/plugin-guest-wifi" };
}

const IMPORT = 'import { guestWifiPlugin } from "@my-agent/plugin-guest-wifi";';

describe("addToManifest", () => {
  const manifest = JSON.stringify({ name: "my-agent", dependencies: { "@mercury-fw/core": "^0.79.2", zod: "^4.6.5" } }, null, 2) + "\n";

  test("adds the package from the workspace, in order", () => {
    expect(JSON.parse(addToManifest(manifest, "@my-agent/plugin-guest-wifi", { trusted: false }))).toEqual({
      name: "my-agent",
      dependencies: { "@mercury-fw/core": "^0.79.2", "@my-agent/plugin-guest-wifi": "workspace:*", zod: "^4.6.5" },
    });
  });

  test("trusts a package with a postinstall, next to those already trusted", () => {
    const trusting = JSON.stringify({ name: "my-agent", dependencies: {}, trustedDependencies: ["@mercury-fw/plugin-jira"] });
    expect(JSON.parse(addToManifest(trusting, "@my-agent/plugin-guest-wifi", { trusted: true })).trustedDependencies).toEqual([
      "@mercury-fw/plugin-jira",
      "@my-agent/plugin-guest-wifi",
    ]);
  });

  test("keeps the manifest's two-space indent and final newline", () => {
    expect(addToManifest(manifest, "@my-agent/plugin-guest-wifi", { trusted: false })).toEndWith("}\n");
    expect(addToManifest(manifest, "@my-agent/plugin-guest-wifi", { trusted: false })).toContain('\n  "dependencies": {\n    "@mercury-fw/core"');
  });
});

describe("declareInConfig", () => {
  test("adds a tool plugin at the end of a new app's plugins, with its import after the others", () => {
    const { text, written } = declareInConfig(NEW_APP, plugin("tool"));
    expect(written).toBe(true);
    expect(text).toContain(
      'import { corrections } from "@mercury-fw/corrections";\nimport { guestWifiPlugin } from "@my-agent/plugin-guest-wifi";\n',
    );
    expect(text).toContain("  plugins: [conversation, teamWiki, longTermMemory, archive(), titles(), profile(), corrections({ wiki: teamWiki }), guestWifiPlugin()],");
  });

  test("adds to a plugins list spread over lines, on a line of its own", () => {
    const config = [IMPORT.replace("guestWifiPlugin", "other").replace("plugin-guest-wifi", "other"), "", "export default defineMercuryConfig({", "  plugins: [", "    conversation,", "    jiraPlugin,", "  ],", "});", ""].join("\n");
    expect(declareInConfig(config, plugin("tool")).text).toContain("  plugins: [\n    conversation,\n    jiraPlugin,\n    guestWifiPlugin(),\n  ],");
  });

  test("adds a channel to an empty channels list", () => {
    const { text, written } = declareInConfig(NEW_APP, plugin("channel", "guestWifiChannel"));
    expect(written).toBe(true);
    expect(text).toContain("  channels: [guestWifiChannel()],");
  });

  test("skips what sits inside strings and nested calls when finding the list's end", () => {
    const config = ['import { a } from "a";', "export default defineMercuryConfig({", '  plugins: [f({ x: "]" }), g([1, 2])],', "});", ""].join("\n");
    expect(declareInConfig(config, plugin("tool")).text).toContain('  plugins: [f({ x: "]" }), g([1, 2]), guestWifiPlugin()],');
  });

  test("sets auth and directory when the app has none", () => {
    expect(declareInConfig(NEW_APP, plugin("auth", "guestWifiAuth")).text).toContain("export default defineMercuryConfig({\n  auth: guestWifiAuth(),\n");
    expect(declareInConfig(NEW_APP, plugin("directory", "guestWifiDirectory")).text).toContain("export default defineMercuryConfig({\n  directory: guestWifiDirectory(),\n");
  });

  test("leaves an auth provider already set alone, and gives the lines to add", () => {
    const config = NEW_APP.replace("  channels: [],", "  channels: [],\n  auth: oidcAuth,");
    expect(declareInConfig(config, plugin("auth", "guestWifiAuth"))).toEqual({
      text: config,
      written: false,
      lines: ['import { guestWifiAuth } from "@my-agent/plugin-guest-wifi";', "auth: guestWifiAuth(),  // or a list with the provider already there: auth: [oidcAuth, guestWifiAuth()]"],
    });
  });

  test("gives the lines for a vector index, a conversation store and a trace sink a new app already has", () => {
    expect(declareInConfig(NEW_APP, plugin("vector-index", "guestWifiVectorIndex"))).toMatchObject({
      written: false,
      lines: ['import { guestWifiVectorIndex } from "@my-agent/plugin-guest-wifi";', "vectorIndex: guestWifiVectorIndex(),  // in place of the one there"],
    });
    expect(declareInConfig(NEW_APP, plugin("conversation-store", "guestWifiConversationStore"))).toMatchObject({
      written: false,
      lines: ['import { guestWifiConversationStore } from "@my-agent/plugin-guest-wifi";', "conversationStore: guestWifiConversationStore(),  // in place of the one there"],
    });
    expect(declareInConfig(NEW_APP, plugin("trace-sink", "guestWifiTraceSink"))).toMatchObject({
      written: false,
      lines: ['import { guestWifiTraceSink } from "@my-agent/plugin-guest-wifi";', "sink: guestWifiTraceSink(),  // in traces, in place of the sink there"],
    });
  });

  test("sets the trace sink of an app that has none", () => {
    const config = NEW_APP.replace(/\n {2}traces: .*\n/, "\n");
    expect(declareInConfig(config, plugin("trace-sink", "guestWifiTraceSink")).text).toContain("export default defineMercuryConfig({\n  traces: { sink: guestWifiTraceSink() },\n");
  });

  test("never writes a context strategy: it takes the place of the profile's conversation", () => {
    expect(declareInConfig(NEW_APP, plugin("context-strategy", "guestWifiStrategy"))).toEqual({
      text: NEW_APP,
      written: false,
      lines: [
        'import { guestWifiStrategy } from "@my-agent/plugin-guest-wifi";',
        "const conversation = guestWifiStrategy();  // in place of the conversation there, in plugins and in the profile",
      ],
    });
  });

  test("leaves a config whose plugins list it can't find alone", () => {
    const config = 'import { a } from "a";\nconst plugins = [a];\nexport default defineMercuryConfig({ plugins, models });\n';
    expect(declareInConfig(config, plugin("tool"))).toEqual({
      text: config,
      written: false,
      lines: [IMPORT, "plugins: [..., guestWifiPlugin()],"],
    });
  });

  test("leaves a config with two plugins lists alone", () => {
    const config = 'import { a } from "a";\nexport default defineMercuryConfig({\n  plugins: [a],\n});\nconst other = {\n  plugins: [a],\n};\n';
    expect(declareInConfig(config, plugin("tool")).written).toBe(false);
  });

  test("leaves a config with no import to follow alone", () => {
    const config = "export default defineMercuryConfig({\n  plugins: [a],\n});\n";
    expect(declareInConfig(config, plugin("tool")).written).toBe(false);
  });

  test("follows an import spread over lines", () => {
    const config = ['import {', "  a,", "  b,", '} from "a";', "export default defineMercuryConfig({", "  plugins: [a],", "});", ""].join("\n");
    expect(declareInConfig(config, plugin("tool")).text).toStartWith(['import {', "  a,", "  b,", '} from "a";', IMPORT, ""].join("\n"));
  });
});
