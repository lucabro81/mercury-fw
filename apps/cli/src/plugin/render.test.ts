/**
 * `renderPlugin` writes a plugin package of one kind: the files each kind
 * has, every placeholder of its templates replaced, the manifest an app's
 * workspace needs, the contract version as a literal. Whether the files
 * typecheck and their tests pass is `generated.test.ts`'s.
 */
import { describe, expect, test } from "bun:test";
import {
  AUTH_API_VERSION,
  CHANNEL_API_VERSION,
  CONVERSATION_STORE_API_VERSION,
  DIRECTORY_API_VERSION,
  PLUGIN_API_VERSION,
  TRACE_SINK_API_VERSION,
  VECTOR_INDEX_API_VERSION,
} from "@mercury-fw/kit";
import { PLUGIN_KINDS, pluginKind, pluginNameError, pluginNames } from "./kinds.ts";
import { renderPlugin, type RenderPluginInput } from "./render.ts";

const VERSIONS = { framework: "0.79.2", ai: "^7.0.126", zod: "^4.6.5" };
const CLI = { binary: "acme", repo: "acme/acme-cli", version: "1.2.3" };

/** The input for `kind`, named `guest-wifi`, in an app called `my-agent`. */
function input(kind: RenderPluginInput["kind"]): RenderPluginInput {
  return {
    kind,
    name: "guest-wifi",
    target: { type: "app", appName: "my-agent" },
    versions: VERSIONS,
    ...(kind === "cli" ? { cli: CLI } : {}),
  };
}

describe("pluginNames", () => {
  test("derives every spelling from the kebab-case name", () => {
    expect(pluginNames("guest-wifi", "tool")).toEqual({
      name: "guest-wifi",
      camel: "guestWifi",
      pascal: "GuestWifi",
      constant: "GUEST_WIFI",
      snake: "guest_wifi",
      title: "Guest wifi",
      exportName: "guestWifiPlugin",
    });
  });

  test.each([
    ["tool", "guestWifiPlugin"],
    ["cli", "guestWifiPlugin"],
    ["memory", "guestWifiPlugin"],
    ["context-strategy", "guestWifiStrategy"],
    ["channel", "guestWifiChannel"],
    ["auth", "guestWifiAuth"],
    ["directory", "guestWifiDirectory"],
    ["trace-sink", "guestWifiTraceSink"],
    ["vector-index", "guestWifiVectorIndex"],
    ["conversation-store", "guestWifiConversationStore"],
  ] as const)("a %s exports %s", (kind, exportName) => {
    expect(pluginNames("guest-wifi", kind).exportName).toBe(exportName);
  });
});

describe("pluginNameError", () => {
  test.each(["guest-wifi", "acme", "a1-b2"])("accepts %s", (name) => {
    expect(pluginNameError(name)).toBeUndefined();
  });

  test.each([
    ["", "a plugin's name can't be empty"],
    ["Guest", 'a plugin\'s name is lowercase words joined by hyphens (e.g. guest-wifi), not "Guest"'],
    ["guest_wifi", 'a plugin\'s name is lowercase words joined by hyphens (e.g. guest-wifi), not "guest_wifi"'],
    ["-guest", 'a plugin\'s name is lowercase words joined by hyphens (e.g. guest-wifi), not "-guest"'],
    ["1guest", 'a plugin\'s name is lowercase words joined by hyphens (e.g. guest-wifi), not "1guest"'],
    ["core", 'a plugin can\'t be named "core" or "app": the core and the app own those message keys'],
    ["app", 'a plugin can\'t be named "core" or "app": the core and the app own those message keys'],
    ["a".repeat(51), "a plugin's name is at most 50 characters"],
  ])("refuses %j", (name, error) => {
    expect(pluginNameError(name)).toBe(error);
  });
});

describe("pluginKind", () => {
  test("knows every kind", () => {
    expect(PLUGIN_KINDS).toEqual([
      "tool",
      "cli",
      "memory",
      "context-strategy",
      "channel",
      "auth",
      "directory",
      "trace-sink",
      "vector-index",
      "conversation-store",
    ]);
  });

  test("declares each where the config takes it, with the contract version it's written for", () => {
    expect(PLUGIN_KINDS.map((k) => [k, pluginKind(k).declare, pluginKind(k).apiVersion])).toEqual([
      ["tool", { in: "array", key: "plugins" }, PLUGIN_API_VERSION],
      ["cli", { in: "array", key: "plugins" }, PLUGIN_API_VERSION],
      ["memory", { in: "array", key: "plugins" }, PLUGIN_API_VERSION],
      ["context-strategy", { in: "profile" }, PLUGIN_API_VERSION],
      ["channel", { in: "array", key: "channels" }, CHANNEL_API_VERSION],
      ["auth", { in: "key", key: "auth" }, AUTH_API_VERSION],
      ["directory", { in: "key", key: "directory" }, DIRECTORY_API_VERSION],
      ["trace-sink", { in: "traces" }, TRACE_SINK_API_VERSION],
      ["vector-index", { in: "key", key: "vectorIndex" }, VECTOR_INDEX_API_VERSION],
      ["conversation-store", { in: "key", key: "conversationStore" }, CONVERSATION_STORE_API_VERSION],
    ]);
  });

  test("names the package by the repo's prefixes", () => {
    expect(PLUGIN_KINDS.map((k) => pluginKind(k).packagePrefix)).toEqual([
      "plugin-",
      "plugin-",
      "",
      "",
      "channel-",
      "auth-",
      "directory-",
      "trace-",
      "store-",
      "store-",
    ]);
  });
});

describe("renderPlugin", () => {
  test.each([
    ["tool", ["README.md", "index.test.ts", "index.ts", "messages.ts", "package.json", "skills/guest-wifi/SKILL.md", "tools.test.ts", "tools.ts"]],
    [
      "cli",
      ["README.md", "acme.json", "allowlist.test.ts", "cli-credentials.test.ts", "index.test.ts", "index.ts", "package.json", "scripts/install-acme-cli.ts"],
    ],
    ["memory", ["README.md", "index.test.ts", "index.ts", "package.json"]],
    ["context-strategy", ["README.md", "index.test.ts", "index.ts", "package.json", "window.test.ts", "window.ts"]],
    ["channel", ["README.md", "index.test.ts", "index.ts", "messages.ts", "package.json"]],
    ["auth", ["README.md", "index.test.ts", "index.ts", "package.json"]],
    ["directory", ["README.md", "index.test.ts", "index.ts", "package.json"]],
    ["trace-sink", ["README.md", "index.test.ts", "index.ts", "package.json"]],
    ["vector-index", ["README.md", "index.test.ts", "index.ts", "package.json"]],
    ["conversation-store", ["README.md", "index.test.ts", "index.ts", "package.json"]],
  ] as const)("a %s has its files", (kind, files) => {
    expect([...renderPlugin(input(kind)).keys()].sort()).toEqual([...files]);
  });

  test.each(PLUGIN_KINDS)("a %s leaves no placeholder behind", (kind) => {
    for (const [path, content] of renderPlugin(input(kind))) {
      expect({ path, left: content.match(/__[A-Z_]+__/g) }).toEqual({ path, left: null });
    }
  });

  test.each(PLUGIN_KINDS)("a %s declares its contract version as a literal", (kind) => {
    const index = renderPlugin(input(kind)).get("index.ts")!;
    expect(index).toContain(`apiVersion: ${pluginKind(kind).apiVersion},`);
    expect(index).not.toMatch(/apiVersion: [A-Z_]+_API_VERSION/);
  });

  test.each(PLUGIN_KINDS)("a %s README opens with a table of contents of its sections", (kind) => {
    const readme = renderPlugin(input(kind)).get("README.md")!;
    const sections = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!).filter((s) => s !== "Contents");
    const contents = readme.slice(readme.indexOf("## Contents"), readme.indexOf("\n## ", readme.indexOf("## Contents") + 1));
    expect(readme).toStartWith(`# @my-agent/${pluginKind(kind).packagePrefix}guest-wifi\n`);
    expect([...contents.matchAll(/^- \[(.+)\]\(#(.+)\)$/gm)].map((m) => m[1])).toEqual(sections);
  });

  test("a tool's manifest: private, the kit, ai and zod, its tests", () => {
    expect(JSON.parse(renderPlugin(input("tool")).get("package.json")!)).toEqual({
      name: "@my-agent/plugin-guest-wifi",
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./index.ts" },
      scripts: { test: "bun test" },
      dependencies: { "@mercury-fw/kit": "^0.79.2", ai: "^7.0.126", zod: "^4.6.5" },
    });
  });

  test("a CLI plugin's manifest: the engine, the binary's pin and login, the postinstall that downloads it", () => {
    expect(JSON.parse(renderPlugin(input("cli")).get("package.json")!)).toEqual({
      name: "@my-agent/plugin-guest-wifi",
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./index.ts" },
      scripts: { postinstall: "bun run scripts/install-acme-cli.ts", test: "bun test" },
      dependencies: { "@mercury-fw/cli-engine": "^0.79.2", "@mercury-fw/kit": "^0.79.2", "@mercury-fw/utils": "^0.79.2" },
      mercury: {
        cliBinary: { repo: "acme/acme-cli", crate: "acme", version: "1.2.3" },
        cliCredentials: { folder: "acme-cli", setup: ["acme", "init"], check: ["acme", "doctor"] },
      },
    });
  });

  test.each(PLUGIN_KINDS.filter((k) => k !== "tool" && k !== "cli"))("a %s depends on the kit only", (kind) => {
    const manifest = JSON.parse(renderPlugin(input(kind)).get("package.json")!) as { name: string; dependencies: unknown };
    expect(manifest.name).toBe(`@my-agent/${pluginKind(kind).packagePrefix}guest-wifi`);
    expect(manifest.dependencies).toEqual({ "@mercury-fw/kit": "^0.79.2" });
  });

  test("a CLI plugin's allowlist names its binary, a read prefix and a confirmed one", () => {
    expect(JSON.parse(renderPlugin(input("cli")).get("acme.json")!)).toEqual({
      binary: "acme",
      commands: [
        { prefix: ["items", "list"], confirm: false, mutating: false },
        { prefix: ["items", "delete"], confirm: true, mutating: true },
      ],
      globalFlags: [],
    });
  });

  test("a CLI plugin needs its binary's coordinates", () => {
    const { cli: _, ...noCli } = input("cli");
    expect(() => renderPlugin(noCli)).toThrow("a cli plugin needs its binary's name, repository and version (--cli-binary, --cli-repo, --cli-version)");
  });

  test("refuses a name that isn't one", () => {
    expect(() => renderPlugin({ ...input("tool"), name: "Guest" })).toThrow('a plugin\'s name is lowercase words joined by hyphens (e.g. guest-wifi), not "Guest"');
  });
});
