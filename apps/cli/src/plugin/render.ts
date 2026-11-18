/**
 * Writes a plugin package of one kind (`./kinds.ts`) from its templates
 * (`./templates/<kind>/*.tpl`, imported as text so they travel in the CLI's
 * bundle): every placeholder replaced by the plugin's name in the spelling it
 * stands for, plus the package's manifest. Pure: what goes on disk, and
 * where, is the caller's.
 */
import { TEMPLATES } from "./templates.ts";
import { pluginKind, pluginNameError, pluginNames, type PluginKind, type PluginNames } from "./kinds.ts";

/**
 * Where the package goes: a workspace of the app called `appName`, or a
 * first-party package of this repository, in the framework's group
 * (`framework`, moving with it) or on its own, written with the repository's
 * `tooling`.
 */
export type PluginTarget =
  | { type: "app"; appName: string }
  | { type: "repo"; framework: boolean; tooling: { bunTypes: string; typescript: string } };

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

/** The package's name: scoped by the app's name (`@mercury-fw` in this repo), prefixed as this repo's are. */
export function pluginPackageName(input: Pick<RenderPluginInput, "kind" | "name" | "target">): string {
  const scope = input.target.type === "app" ? input.target.appName : "mercury-fw";
  return `@${scope}/${pluginKind(input.kind).packagePrefix}${input.name}`;
}

/** Where a first-party package lives in this repository. */
export function pluginRepoDir(input: Pick<RenderPluginInput, "kind" | "name">): string {
  const kind = pluginKind(input.kind);
  return `packages/${kind.bucket}/${kind.packagePrefix}${input.name}`;
}

/** Every file of the package, by its path inside the package's folder. Throws
 * on a name that isn't one, or a `cli` plugin without its binary's pin. */
export function renderPlugin(input: RenderPluginInput): Map<string, string> {
  const error = pluginNameError(input.name);
  if (error !== undefined) throw new Error(error);
  if (input.kind === "cli" && input.cli === undefined) {
    throw new Error("a cli plugin needs its binary's name, repository and version (--cli-binary, --cli-repo, --cli-version)");
  }
  if (input.kind === "cli" && input.cli !== undefined) {
    const pinError = cliPinError(input.cli);
    if (pinError !== undefined) throw new Error(pinError);
  }
  const names = pluginNames(input.name, input.kind);
  const fill = (text: string) => fillPlaceholders(text, names, input);
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(TEMPLATES[input.kind])) {
    files.set(fill(path), fill(text));
  }
  files.set("package.json", input.target.type === "app" ? renderManifest(input) : renderRepoManifest(input, input.target));
  if (input.target.type === "repo") files.set("tsconfig.json", renderTsconfig(input.kind));
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** What's wrong with `pin`, or `undefined`: the binary's name goes into file names, JSON and code, so it's a plain name. */
function cliPinError(pin: CliPin): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(pin.binary)) {
    return `--cli-binary is a program's name (letters, digits, - and _), not ${JSON.stringify(pin.binary)}`;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.repo)) return `--cli-repo is a GitHub repository, owner/name, not ${JSON.stringify(pin.repo)}`;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pin.version)) {
    return `--cli-version is a release's version, as 1.2.3, not ${JSON.stringify(pin.version)}`;
  }
  return undefined;
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

/** `deps` sorted by name. */
function sorted(deps: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
}

/** The framework's packages a kind is written with: the kit, and the engine and utils for a CLI plugin. */
function frameworkPackages(kind: PluginKind): string[] {
  return kind === "cli" ? ["@mercury-fw/kit", "@mercury-fw/cli-engine", "@mercury-fw/utils"] : ["@mercury-fw/kit"];
}

/** The other packages a kind is written with: `ai` and `zod` for typed tools. */
function otherPackages(input: RenderPluginInput): Record<string, string> {
  return input.kind === "tool" ? { ai: input.versions.ai, zod: input.versions.zod } : {};
}

/** The packages each kind is written with, for an app's workspace. */
function dependencies(input: RenderPluginInput): Record<string, string> {
  const framework = `^${input.versions.framework}`;
  return sorted({ ...Object.fromEntries(frameworkPackages(input.kind).map((p) => [p, framework])), ...otherPackages(input) });
}

/**
 * A first-party package's `package.json`: what publishing needs (`files`, the
 * `exports` reading the source here and the declarations once published), and
 * its framework packages from the workspace, as dependencies in the
 * framework's group, otherwise as peers from the framework's minor to the end
 * of 0.x (the loader's `apiVersion` check is the real gate).
 */
function renderRepoManifest(input: RenderPluginInput, target: Extract<PluginTarget, { type: "repo" }>): string {
  const [major, minor] = input.versions.framework.split(".");
  const framework = frameworkPackages(input.kind);
  const fromWorkspace = Object.fromEntries(framework.map((p) => [p, "workspace:*"]));
  const tooling = { "@mercury-fw/typescript-config": "*", "@types/bun": target.tooling.bunTypes, typescript: target.tooling.typescript };
  const other = otherPackages(input);
  const extraFiles = input.kind === "tool" ? ["skills"] : input.kind === "cli" && input.cli ? [`${input.cli.binary}.json`, "scripts"] : [];
  const manifest: Record<string, unknown> = {
    name: pluginPackageName(input),
    version: target.framework ? input.versions.framework : "0.0.0",
    type: "module",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/lucabro81/mercury-fw.git", directory: pluginRepoDir(input) },
    files: ["*.ts", "dist", "CHANGELOG.md", ...extraFiles, "!**/*.test.ts"],
    publishConfig: { access: "public" },
    exports: { ".": { "mercury-fw-source": "./index.ts", types: "./dist/index.d.ts", default: "./index.ts" } },
    scripts: {
      ...(input.kind === "cli" && input.cli ? { postinstall: `bun run scripts/install-${input.cli.binary}-cli.ts` } : {}),
      test: "bun test",
      typecheck: "tsc --noEmit",
    },
  };
  if (target.framework) {
    manifest.dependencies = sorted({ ...fromWorkspace, ...other });
    manifest.devDependencies = tooling;
  } else {
    manifest.peerDependencies = sorted(Object.fromEntries(framework.map((p) => [p, `>=${major}.${minor}.0 <1.0.0`])));
    if (Object.keys(other).length > 0) manifest.dependencies = sorted(other);
    manifest.devDependencies = sorted({ ...fromWorkspace, ...tooling });
  }
  if (input.kind === "cli" && input.cli) manifest.mercury = cliBlock(input.cli);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** `tsconfig.json`: the repo's, reading JSON for a CLI plugin's allowlist. */
function renderTsconfig(kind: PluginKind): string {
  const config = kind === "cli" ? { extends: "@mercury-fw/typescript-config/base.json", compilerOptions: { resolveJsonModule: true } } : { extends: "@mercury-fw/typescript-config/base.json" };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A CLI plugin's `mercury` block: the pinned binary, and where its login lives with the commands that set it up and check it. */
function cliBlock({ binary, repo, version }: CliPin) {
  return {
    cliBinary: { repo, crate: binary, version },
    cliCredentials: { folder: `${binary}-cli`, setup: [binary, "init"], check: [binary, "doctor"] },
  };
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
  if (input.kind === "cli" && input.cli) manifest.mercury = cliBlock(input.cli);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
