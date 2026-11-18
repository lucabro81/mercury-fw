/**
 * `bun run new-plugin <kind> <name>`: writes a first-party plugin package into
 * this repository, from the templates `mfw plugin create` writes an app's
 * plugins from (`apps/cli/src/plugin`), with what the repository needs around
 * it:
 * - the package under `packages/<bucket>/`, with its manifest for publishing
 *   (`files`, `exports`, the framework as peers from its minor, or from the
 *   workspace in the framework's group) and its tsconfig;
 * - its changeset;
 * - with `--framework` (the default for memory, context strategies, trace
 *   sinks and the stores, as today), its name in the framework's `fixed`
 *   group; `--independent` says otherwise;
 * - with `--catalog`, its entry in `mfw create`'s catalog, the line of the
 *   catalog's test, the CLI's dev dependency on it, its page on the site.
 * It writes nothing when a check fails, and prints what's left for a person:
 * the AGENTS.md line, the first publish by hand and the trusted publisher.
 *
 * Usage: bun run new-plugin <kind> <name> [--framework | --independent] [--catalog]
 *        [--cli-binary <name> --cli-repo <owner/repo> --cli-version <x.y.z>]
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pluginKind, pluginNames, type PluginKind } from "../apps/cli/src/plugin/kinds.ts";
import { pluginPackageName, pluginRepoDir, renderPlugin, type CliPin } from "../apps/cli/src/plugin/render.ts";
import { root, workspaces } from "./workspaces.ts";

export type NewPluginArgs = { kind: string; name: string; framework?: boolean; catalog?: boolean; cli?: CliPin };

/** What the plan reads of the repository: a file's text (`undefined` when it isn't there), every workspace's name. */
export type RepoView = { read: (path: string) => string | undefined; workspaceNames: string[] };

/** What a run does: the files to write (new or rewritten), by path from the root, and what to print. */
export type NewPluginPlan = { writes: Map<string, string>; notes: string[] };

/** The buckets whose packages move with the framework, as today's do. */
const FRAMEWORK_BUCKETS = new Set(["memory", "traces", "stores"]);

/** The kinds `mfw create`'s catalog offers, as the catalog names them. */
const CATALOG_KINDS: Partial<Record<PluginKind, string>> = { tool: "tool", cli: "tool", channel: "channel", auth: "auth", directory: "directory" };

/** The settings each catalog kind's template reads, for its catalog entry. */
function catalogEnv(kind: PluginKind, constant: string): string {
  switch (kind) {
    case "tool":
      return `[{ name: "${constant}_URL", comment: "Required: the service's address" }]`;
    case "channel":
      return `[{ name: "${constant}_PORT", comment: "Optional: the port the channel listens on, 4200 unless set" }]`;
    case "auth":
      return `[{ name: "${constant}_KEYS", comment: "Required: the API keys, key=id pairs separated by commas" }]`;
    case "directory":
      return `[{ name: "${constant}_PEOPLE", comment: "Required: the people, as JSON: [{\\"id\\": \\"ada\\", \\"roles\\": [], \\"identities\\": [{\\"provider\\": \\"static\\", \\"id\\": \\"ada\\"}]}]" }]`;
    default:
      return "[]";
  }
}

/** A JSON file's text with `edit` applied, two-space indented. */
function editJson(text: string, edit: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  edit(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** `text` with `insert` before the first `anchor` found after `after`; throws naming `file` when either isn't there. */
function insertBefore(text: string, file: string, after: string, anchor: string, insert: string): string {
  const start = text.indexOf(after);
  const at = start === -1 ? -1 : text.indexOf(anchor, start);
  if (at === -1) throw new Error(`${file}: can't find where to add the entry (${JSON.stringify(anchor)}); add it by hand`);
  return text.slice(0, at) + insert + text.slice(at);
}

/** Plans the new plugin (see the module comment); throws, writing nothing, on anything wrong. */
export function planNewPlugin(args: NewPluginArgs, repo: RepoView): NewPluginPlan {
  const spec = pluginKind(args.kind);
  const kind = args.kind as PluginKind;
  const framework = args.framework ?? FRAMEWORK_BUCKETS.has(spec.bucket);
  const must = (path: string) => {
    const text = repo.read(path);
    if (text === undefined) throw new Error(`${path} isn't there`);
    return text;
  };
  const core = JSON.parse(must("packages/libs/core/package.json")) as { dependencies: Record<string, string> };
  const kit = JSON.parse(must("packages/libs/kit/package.json")) as { version: string };
  const cliManifest = must("apps/cli/package.json");
  const cliDev = (JSON.parse(cliManifest) as { devDependencies: Record<string, string> }).devDependencies;
  const target = { type: "repo" as const, framework, tooling: { bunTypes: cliDev["@types/bun"]!, typescript: cliDev.typescript! } };

  const files = renderPlugin({
    kind,
    name: args.name,
    target,
    versions: { framework: kit.version, ai: core.dependencies.ai!, zod: core.dependencies.zod! },
    ...(args.cli === undefined ? {} : { cli: args.cli }),
  });
  const packageName = pluginPackageName({ kind, name: args.name, target });
  const dir = pluginRepoDir({ kind, name: args.name });
  if (repo.workspaceNames.includes(packageName) || repo.read(`${dir}/package.json`) !== undefined) {
    throw new Error(`${packageName} is there already`);
  }
  const catalogKind = CATALOG_KINDS[kind];
  if (args.catalog && catalogKind === undefined) {
    throw new Error(`mfw create's catalog lists tools, CLI plugins, channels, auth providers and directories, not ${spec.label}`);
  }

  const writes = new Map<string, string>();
  for (const [path, content] of files) writes.set(`${dir}/${path}`, content);
  const slug = packageName.replace(/^@[^/]+\//, "");
  writes.set(`.changeset/new-${slug}.md`, `---\n"${packageName}": minor\n---\n\n- first version\n`);
  if (framework) {
    writes.set(
      ".changeset/config.json",
      editJson(must(".changeset/config.json"), (config) => {
        const fixed = (config.fixed as string[][])[0]!;
        // Before the CLI and create-mercury-agent, which close the group.
        fixed.splice(fixed.indexOf("@mercury-fw/cli"), 0, packageName);
      }),
    );
  }

  const names = pluginNames(args.name, kind);
  if (args.catalog && catalogKind !== undefined) {
    const entry = [
      "  {",
      `    id: "${args.name}",`,
      `    kind: "${catalogKind}",`,
      `    package: "${packageName}",`,
      `    exportName: "${names.exportName}",`,
      "    factory: true,",
      `    env: ${catalogEnv(kind, names.constant)},`,
      "  },\n",
    ].join("\n");
    const catalogPath = "apps/cli/src/catalog.ts";
    writes.set(catalogPath, insertBefore(must(catalogPath), catalogPath, "export const CATALOG", "];\n\n/** The catalog entry of", entry));
    const testPath = "apps/cli/src/catalog.test.ts";
    writes.set(testPath, insertBefore(must(testPath), testPath, "expect(CATALOG.map(", "    ]);", `      "${catalogKind}:${args.name}",\n`));
    writes.set(
      "apps/cli/package.json",
      editJson(cliManifest, (pkg) => {
        const dev = { ...(pkg.devDependencies as Record<string, string>), [packageName]: "workspace:*" };
        pkg.devDependencies = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)));
      }),
    );
    writes.set(`apps/docs/src/content/docs/plugins/${slug}.mdx`, docsPage(slug, names.title, spec.summary, packageName, names.exportName));
  }

  const notes = [
    `Wrote ${dir} (${packageName}), ${spec.label}, and its changeset.`,
    ...(framework ? ["It moves with the framework: it's in the fixed group of .changeset/config.json."] : []),
    ...(args.catalog ? [`mfw create offers it; its page is apps/docs/src/content/docs/plugins/${slug}.mdx.`] : []),
    "Next:",
    "  bun install",
    "  bun run typecheck && bun run test && bun scripts/check-pack.ts",
    `  AGENTS.md: a line for it in the repo tree, under packages/${spec.bucket}/`,
    `  replace the example ${kind === "tool" ? "tools" : "code"}, and the README, with the plugin's own`,
    ...(args.catalog ? ["  fill in its page on the site"] : []),
    "After its first release (npm takes no trusted publisher before the package exists), from outside the repo:",
    "  npm login",
    "  npm publish <its tarball from bun pm pack> --access public",
    `  npm trust github ${packageName} --file publish.yml --repo lucabro81/mercury-fw --allow-publish --yes`,
  ];
  return { writes, notes };
}

/** The plugin's page on the site, to fill in: the facts the catalog gives, and how to add it. */
function docsPage(slug: string, title: string, summary: string, packageName: string, exportName: string): string {
  return `---
title: ${title}
description: ${summary[0]!.toUpperCase()}${summary.slice(1)}.
---

import PluginFacts from "../../../components/PluginFacts.astro";

<PluginFacts slug="${slug}" />

What it does, for someone who has never seen it.

## Adding it

\`bun add ${packageName}\`, then declare it:

\`\`\`ts title="mercury.config.ts"
import { ${exportName} } from "${packageName}";
\`\`\`
`;
}

/** Runs the command line: plans, writes, prints. */
async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      framework: { type: "boolean" },
      independent: { type: "boolean" },
      catalog: { type: "boolean" },
      "cli-binary": { type: "string" },
      "cli-repo": { type: "string" },
      "cli-version": { type: "string" },
    },
  });
  const [kind, name, ...rest] = positionals;
  if (kind === undefined || name === undefined || rest.length > 0) {
    console.error("Usage: bun run new-plugin <kind> <name> [--framework | --independent] [--catalog] [--cli-binary <name> --cli-repo <owner/repo> --cli-version <x.y.z>]");
    return 1;
  }
  if (values.framework && values.independent) {
    console.error("--framework or --independent, not both");
    return 1;
  }
  const pin = [values["cli-binary"], values["cli-repo"], values["cli-version"]];
  const cli = pin.every((v) => v !== undefined) ? { cli: { binary: pin[0]!, repo: pin[1]!, version: pin[2]! } } : {};
  const framework = values.framework ? { framework: true } : values.independent ? { framework: false } : {};
  try {
    const { writes, notes } = planNewPlugin(
      { kind, name, ...framework, ...(values.catalog ? { catalog: true } : {}), ...cli },
      {
        read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf-8") : undefined),
        workspaceNames: workspaces().map((w) => w.pkg.name),
      },
    );
    for (const [path, content] of writes) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    for (const line of notes) console.log(line);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
