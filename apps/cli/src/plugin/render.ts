/**
 * Writes a plugin package of one kind (`./kinds.ts`) from its templates
 * (`./templates/<kind>/*.tpl`, imported as text so they travel in the CLI's
 * bundle): every placeholder replaced by the plugin's name in the spelling it
 * stands for, plus the package's manifest. Pure: what goes on disk, and
 * where, is the caller's.
 */
import { TEMPLATES } from "./templates.ts";
import { pluginKind, pluginNameError, pluginNames, type PluginKind, type PluginNames } from "./kinds.ts";

/** Where the package goes: a workspace of the app called `appName`. */
export type PluginTarget = { type: "app"; appName: string };

/** The pinned command-line program a `cli` plugin runs: its binary's name, the repository releasing it, the version. */
export type CliPin = { binary: string; repo: string; version: string };

export type RenderPluginInput = {
  kind: PluginKind;
  name: string;
  target: PluginTarget;
  /** The framework's version, and the ranges of `ai` and `zod` the framework is built with. */
  versions: { framework: string; ai: string; zod: string };
  cli?: CliPin;
};

/** The package's name: scoped by the app's name, prefixed as this repo's are. */
export function pluginPackageName(input: Pick<RenderPluginInput, "kind" | "name" | "target">): string {
  return `@${input.target.appName}/${pluginKind(input.kind).packagePrefix}${input.name}`;
}

/** Every file of the package, by its path inside the package's folder. Throws
 * on a name that isn't one, or a `cli` plugin without its binary's pin. */
export function renderPlugin(input: RenderPluginInput): Map<string, string> {
  const error = pluginNameError(input.name);
  if (error !== undefined) throw new Error(error);
  if (input.kind === "cli" && input.cli === undefined) {
    throw new Error("a cli plugin needs its binary's name, repository and version (--cli-binary, --cli-repo, --cli-version)");
  }
  const names = pluginNames(input.name, input.kind);
  const fill = (text: string) => fillPlaceholders(text, names, input);
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(TEMPLATES[input.kind])) {
    files.set(fill(path), fill(text));
  }
  files.set("package.json", renderManifest(input));
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** The placeholders the templates use. */
const PLACEHOLDER = /__(?:NAME|CAMEL|PASCAL|CONSTANT|SNAKE|TITLE|EXPORT|PACKAGE|API_VERSION|BINARY)__/g;

/** `text` with each placeholder replaced: the plugin's name in every spelling, its export, package and contract version, the CLI's binary. */
function fillPlaceholders(text: string, names: PluginNames, input: RenderPluginInput): string {
  const values: Record<string, string> = {
    __NAME__: names.name,
    __CAMEL__: names.camel,
    __PASCAL__: names.pascal,
    __CONSTANT__: names.constant,
    __SNAKE__: names.snake,
    __TITLE__: names.title,
    __EXPORT__: names.exportName,
    __PACKAGE__: pluginPackageName(input),
    __API_VERSION__: String(pluginKind(input.kind).apiVersion),
    __BINARY__: input.cli?.binary ?? "",
  };
  // Named one by one: `__SNAKE___list` is `__SNAKE__` then `_list`, which a
  // pattern for any capitals between double underscores would read as `__SNAKE___`.
  return text.replace(PLACEHOLDER, (token) => values[token] ?? token);
}

/** The packages each kind is written with, besides the kit. */
function dependencies(input: RenderPluginInput): Record<string, string> {
  const framework = `^${input.versions.framework}`;
  const deps: Record<string, string> = { "@mercury-fw/kit": framework };
  if (input.kind === "tool") Object.assign(deps, { ai: input.versions.ai, zod: input.versions.zod });
  if (input.kind === "cli") Object.assign(deps, { "@mercury-fw/cli-engine": framework, "@mercury-fw/utils": framework });
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
}

/** `package.json`: a private workspace of the app; a `cli` plugin's also pins its binary, downloaded by its postinstall, and says where its login lives. */
function renderManifest(input: RenderPluginInput): string {
  const manifest: Record<string, unknown> = {
    name: pluginPackageName(input),
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { ".": "./index.ts" },
    scripts: input.cli && input.kind === "cli" ? { postinstall: `bun run scripts/install-${input.cli.binary}-cli.ts`, test: "bun test" } : { test: "bun test" },
    dependencies: dependencies(input),
  };
  if (input.kind === "cli" && input.cli) {
    const { binary, repo, version } = input.cli;
    manifest.mercury = {
      cliBinary: { repo, crate: binary, version },
      cliCredentials: { folder: `${binary}-cli`, setup: [binary, "init"], check: [binary, "doctor"] },
    };
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
