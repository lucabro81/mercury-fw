/**
 * `bun run new-plugin`: a first-party plugin package written into this
 * repository from the same templates `mfw plugin create` uses, with what the
 * repository needs around it (its changeset, the framework's group when it
 * moves with the framework, the `mfw create` catalog and its docs page when
 * asked), and the steps only a person can take. Planned against the real
 * repository's files, so a moved anchor fails here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planNewPlugin, type NewPluginArgs } from "./new-plugin.ts";
import { root, workspaces } from "./workspaces.ts";

/** The repository as it is. */
const repo = {
  read: (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf-8") : undefined),
  workspaceNames: workspaces().map((w) => w.pkg.name),
};

const FRAMEWORK = (JSON.parse(readFileSync(join(root, "packages/libs/kit/package.json"), "utf-8")) as { version: string }).version;
const [MAJOR, MINOR] = FRAMEWORK.split(".");

const plan = (args: NewPluginArgs) => planNewPlugin(args, repo);

describe("planNewPlugin", () => {
  test("a tool on its own: its package in packages/tools, its changeset, nothing in the framework's group", () => {
    const { writes, notes } = plan({ kind: "tool", name: "guest-wifi" });
    expect([...writes.keys()].filter((p) => p.startsWith("packages/")).sort()).toEqual([
      "packages/tools/plugin-guest-wifi/README.md",
      "packages/tools/plugin-guest-wifi/index.test.ts",
      "packages/tools/plugin-guest-wifi/index.ts",
      "packages/tools/plugin-guest-wifi/messages.ts",
      "packages/tools/plugin-guest-wifi/package.json",
      "packages/tools/plugin-guest-wifi/skills/guest-wifi/SKILL.md",
      "packages/tools/plugin-guest-wifi/tools.test.ts",
      "packages/tools/plugin-guest-wifi/tools.ts",
      "packages/tools/plugin-guest-wifi/tsconfig.json",
    ]);
    const manifest = JSON.parse(writes.get("packages/tools/plugin-guest-wifi/package.json")!);
    expect(manifest.peerDependencies).toEqual({ "@mercury-fw/kit": `>=${MAJOR}.${MINOR}.0 <1.0.0` });
    expect(writes.get(".changeset/new-plugin-guest-wifi.md")).toBe('---\n"@mercury-fw/plugin-guest-wifi": minor\n---\n\n- first version\n');
    expect(writes.has(".changeset/config.json")).toBe(false);
    expect(notes).toEqual([
      "Wrote packages/tools/plugin-guest-wifi (@mercury-fw/plugin-guest-wifi), a tool plugin, and its changeset.",
      "Next:",
      "  bun install",
      "  bun run typecheck && bun run test && bun scripts/check-pack.ts",
      "  AGENTS.md: a line for it in the repo tree, under packages/tools/",
      "  replace the example tools, and the README, with the plugin's own",
      "After its first release (npm takes no trusted publisher before the package exists), from outside the repo:",
      "  npm login",
      "  npm publish <its tarball from bun pm pack> --access public",
      "  npm trust github @mercury-fw/plugin-guest-wifi --file publish.yml --repo lucabro81/mercury-fw --allow-publish --yes",
    ]);
  });

  test("a memory plugin moves with the framework: its version, the fixed group", () => {
    const { writes } = plan({ kind: "memory", name: "topics" });
    expect(JSON.parse(writes.get("packages/memory/topics/package.json")!)).toMatchObject({
      version: FRAMEWORK,
      dependencies: { "@mercury-fw/kit": "workspace:*" },
    });
    const config = JSON.parse(writes.get(".changeset/config.json")!) as { fixed: string[][] };
    expect(config.fixed[0]).toContain("@mercury-fw/topics");
    expect(config.fixed[0]!.at(-1)).toBe("create-mercury-agent");
  });

  test.each([
    ["tool", false],
    ["cli", false],
    ["channel", false],
    ["auth", false],
    ["directory", false],
    ["memory", true],
    ["context-strategy", true],
    ["trace-sink", true],
    ["vector-index", true],
    ["conversation-store", true],
  ] as const)("a %s is in the framework's group unless told otherwise: %p", (kind, framework) => {
    const args: NewPluginArgs = { kind, name: "demo", ...(kind === "cli" ? { cli: { binary: "demo", repo: "acme/demo", version: "1.0.0" } } : {}) };
    expect(plan(args).writes.has(".changeset/config.json")).toBe(framework);
    expect(plan({ ...args, framework: !framework }).writes.has(".changeset/config.json")).toBe(!framework);
  });

  test("--catalog: the mfw create entry, its catalog test, the CLI's dev dependency, a docs page", () => {
    const { writes } = plan({ kind: "channel", name: "guest-wifi", catalog: true });
    const catalog = writes.get("apps/cli/src/catalog.ts")!;
    expect(catalog).toContain(
      [
        "  {",
        '    id: "guest-wifi",',
        '    kind: "channel",',
        '    package: "@mercury-fw/channel-guest-wifi",',
        '    exportName: "guestWifiChannel",',
        "    factory: true,",
        '    env: [{ name: "GUEST_WIFI_PORT", comment: "Optional: the port the channel listens on, 4200 unless set" }],',
        "  },",
        "];",
      ].join("\n"),
    );
    expect(writes.get("apps/cli/src/catalog.test.ts")).toContain('      "directory:zitadel",\n      "channel:guest-wifi",\n    ]);');
    expect(JSON.parse(writes.get("apps/cli/package.json")!).devDependencies["@mercury-fw/channel-guest-wifi"]).toBe("workspace:*");
    const page = writes.get("apps/docs/src/content/docs/plugins/channel-guest-wifi.mdx")!;
    expect(page).toStartWith('---\ntitle: Guest wifi\ndescription: A way people talk to the agent.\n---\n');
    expect(page).toContain('<PluginFacts slug="channel-guest-wifi" />');
  });

  test("--catalog for a CLI plugin: it is trusted by the app, through the catalog's tool kind", () => {
    const { writes } = plan({ kind: "cli", name: "acme", catalog: true, cli: { binary: "acme", repo: "acme/acme-cli", version: "1.2.3" } });
    expect(writes.get("apps/cli/src/catalog.ts")).toContain('    kind: "tool",\n    package: "@mercury-fw/plugin-acme",\n    exportName: "acmePlugin",\n    factory: true,\n    env: [],');
  });

  test("refuses --catalog for a kind mfw create doesn't offer", () => {
    expect(() => plan({ kind: "memory", name: "topics", catalog: true })).toThrow(
      "mfw create's catalog lists tools, CLI plugins, channels, auth providers and directories, not a memory plugin",
    );
  });

  test("refuses a name a package already has, or a folder already there", () => {
    expect(() => plan({ kind: "tool", name: "jira" })).toThrow("@mercury-fw/plugin-jira is there already");
    expect(() => plan({ kind: "memory", name: "wiki" })).toThrow("@mercury-fw/wiki is there already");
  });

  test("refuses what renderPlugin refuses", () => {
    expect(() => plan({ kind: "tool", name: "Guest" })).toThrow("a plugin's name is lowercase words");
    expect(() => plan({ kind: "cli", name: "acme" })).toThrow("a cli plugin needs its binary's name");
  });
});
