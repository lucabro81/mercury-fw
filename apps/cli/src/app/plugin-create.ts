/**
 * `mfw plugin create <kind> <name>`: writes a plugin package of the app's own
 * under `plugins/<name>` (a workspace every app declares), declares it in the
 * app's `package.json` and, where the place is clear, in `mercury.config.ts`,
 * then runs `bun install` to link it. The package is written against the
 * framework at this CLI's version, which is the app's (a global `mfw` hands
 * an app's commands to the app's own), and `ai` and `zod` at the ranges the
 * app's core is built with. Everything is checked before anything is written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppDeps } from "./commands.ts";
import type { App } from "./find-app.ts";
import { addToManifest, declareInConfig } from "../plugin/declare.ts";
import { pluginKind, pluginNames, PLUGIN_KINDS, type PluginKind } from "../plugin/kinds.ts";
import { pluginPackageName, renderPlugin, type CliPin } from "../plugin/render.ts";
import { cliVersion } from "../versions.ts";

export type PluginCreateArgs = { kind: string; name: string; cli?: CliPin };

/** The scope an app's packages take: its name, without a scope of its own. */
function scopeOf(appName: string): string {
  return appName.replace(/^@/, "").replace("/", "-");
}

/** The ranges of `ai` and `zod` the app's installed core is built with; throws when the app isn't installed. */
function coreRanges(appDir: string): { ai: string; zod: string } {
  const manifest = join(appDir, "node_modules/@mercury-fw/core/package.json");
  if (!existsSync(manifest)) throw new Error("The app's packages aren't installed: run bun install first");
  const deps = (JSON.parse(readFileSync(manifest, "utf-8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  if (deps.ai === undefined || deps.zod === undefined) throw new Error(`${manifest} names no ai or zod`);
  return { ai: deps.ai, zod: deps.zod };
}

/** Creates the plugin (see the module comment); returns `bun install`'s exit code. */
export async function pluginCreate(app: App, deps: AppDeps, args: PluginCreateArgs): Promise<number> {
  const spec = pluginKind(args.kind);
  const kind = args.kind as PluginKind;
  const folder = `plugins/${args.name}`;
  const target = { type: "app" as const, appName: scopeOf(app.name) };
  const files = renderPlugin({
    kind,
    name: args.name,
    target,
    versions: { framework: cliVersion(), ...coreRanges(app.dir) },
    ...(args.cli === undefined ? {} : { cli: args.cli }),
  });
  if (existsSync(join(app.dir, folder))) throw new Error(`${folder} is there already`);

  const packageName = pluginPackageName({ kind, name: args.name, target });
  const manifestPath = join(app.dir, "package.json");
  const configPath = join(app.dir, "mercury.config.ts");
  const manifest = addToManifest(readFileSync(manifestPath, "utf-8"), packageName, { trusted: kind === "cli" });
  const declared = declareInConfig(readFileSync(configPath, "utf-8"), { kind, exportName: pluginNames(args.name, kind).exportName, packageName });

  for (const [path, content] of files) {
    const file = join(app.dir, folder, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(manifestPath, manifest);
  if (declared.written) writeFileSync(configPath, declared.text);

  deps.print(`Wrote ${folder} (${packageName}), ${spec.label}.`);
  if (declared.written) {
    deps.print("Declared it in package.json and in mercury.config.ts.");
  } else {
    deps.print("Declared it in package.json. Add it to mercury.config.ts:");
    for (const line of declared.lines) deps.print(`  ${line}`);
  }
  if (kind === "memory") deps.print(`The model reads it once a context profile lists it in its layers (${folder}/README.md).`);
  deps.print(`Next: its settings (${folder}/README.md), bun run test, then mfw restart.`);
  return deps.run(["bun", "install"], { cwd: app.dir });
}

/** The kinds, with what each is, for `mfw plugin create --help`. */
export function pluginKindsHelp(): string {
  const width = Math.max(...PLUGIN_KINDS.map((k) => k.length));
  return PLUGIN_KINDS.map((k) => `  ${k.padEnd(width)}  ${pluginKind(k).summary}`).join("\n");
}
