/**
 * The `mfw` command. `create <folder>` writes a new Mercury app from the
 * template, asking what to put in it (or taking the answers from flags with
 * `--yes`), then installs it and commits it to a new repository (`finish.ts`). The other
 * commands operate an existing app from inside its folder (see
 * `app/commands.ts`). The command line itself is declared in `program.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CreateArgs } from "./args.ts";
import { CATALOG } from "./catalog.ts";
import { kebabCase } from "./naming.ts";
import { runProgram } from "./program.ts";
import { pairingError, renderApp, selectionError } from "./render.ts";
import { appVersions, cliVersion, newerCli, registryFrom } from "./versions.ts";
import { appCommands, terminalDeps, type AppDeps } from "./app/commands.ts";
import { findApp, type App } from "./app/find-app.ts";
import { askAnswers, DEFAULT_ASSISTANT_NAME, DEFAULT_ROLE, type Answers } from "./wizard.ts";
import { finishApp, finishMessage, spawnRun, type Run } from "./finish.ts";
import { targetError, writeApp } from "./write.ts";

/** The answers taken from the flags alone, defaults for the rest. */
function answersFromFlags(args: CreateArgs, defaultName: string): Answers {
  return {
    name: args.name ?? defaultName,
    assistantName: args.assistantName ?? DEFAULT_ASSISTANT_NAME,
    role: args.role ?? DEFAULT_ROLE,
    channels: args.channels ?? [],
    plugins: args.plugins ?? [],
    ...(args.auth !== undefined ? { auth: args.auth } : {}),
    ...(args.gitRemote !== undefined ? { gitRemote: args.gitRemote } : {}),
  };
}

/** Runs `argv` with stdio inherited and `env` on top of this process's
 * environment; returns its exit code. */
export type Relaunch = (argv: string[], env: Record<string, string>, opts?: { quiet?: boolean }) => Promise<number>;

/** The real relaunch: a child process on the user's terminal (its output
 * dropped with `quiet`). While it runs, Ctrl+C is the child's to handle: this
 * process ignores SIGINT, so it doesn't exit ahead of the child and lose its
 * exit code. */
const spawnRelaunch: Relaunch = async (argv, env, opts) => {
  const output = opts?.quiet ? "ignore" : "inherit";
  const proc = Bun.spawn(argv, { stdin: "inherit", stdout: output, stderr: output, env: { ...process.env, ...env } });
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    return await proc.exited;
  } finally {
    process.off("SIGINT", ignore);
  }
};

/** Whether this CLI runs from Bun's global install (`bun add -g`), the one
 * `mfw upgrade` updates, rather than from `bunx`'s cache or an app. */
function isGlobalInstall(): boolean {
  return /[\\/]install[\\/]global[\\/]node_modules[\\/]/.test(import.meta.dir);
}

/** When the registry has a newer `@mercury-fw/cli` than this one (a stale copy
 * out of Bun's bunx cache), installs it (`bunx … --version`), then runs
 * `create` again through it with the same arguments as typed and returns its
 * exit code, whatever it is (a cancelled wizard included). `undefined` means
 * carry on here: no newer CLI, a check skipped inside a relaunch
 * (`MFW_SELF_UPDATED`), a registry that can't answer, or a newer CLI that
 * can't be installed; the last two with a warning. */
async function relaunchIfStale(rawArgs: string[], relaunch: Relaunch, globalInstall: boolean): Promise<number | undefined> {
  if (process.env.MFW_SELF_UPDATED) return undefined;
  const registry = registryFrom(process.env.MFW_REGISTRY).replace(/\/+$/, "");
  let newer: string | undefined;
  try {
    newer = await newerCli({ registry });
  } catch (err) {
    console.error(`couldn't check for a newer mfw: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (newer === undefined) return undefined;
  const cli = `@mercury-fw/cli@${newer}`;
  const env = { MFW_SELF_UPDATED: newer, NPM_CONFIG_REGISTRY: registry };
  let installed: number;
  try {
    installed = await relaunch(["bunx", cli, "--version"], env, { quiet: true });
  } catch {
    installed = -1;
  }
  if (installed !== 0) {
    console.error(`mfw ${cliVersion()} is behind the registry's ${newer}, which couldn't be installed: creating with ${cliVersion()}.`);
    return undefined;
  }
  console.error(`mfw ${cliVersion()} is behind the registry's ${newer}: running ${newer} instead.`);
  if (globalInstall) console.error("update your mfw: mfw upgrade");
  return relaunch(["bunx", cli, "create", ...rawArgs], env);
}

/** What's wrong with `--git-remote`, or undefined. It's taken as typed, but
 * one starting with "-" would reach git as an option. */
function remoteError(args: CreateArgs): string | undefined {
  if (args.gitRemote === undefined) return undefined;
  if (!args.git) return "--git-remote needs the repository: drop --no-git";
  if (args.gitRemote.startsWith("-")) return `--git-remote "${args.gitRemote}" isn't a remote`;
  return undefined;
}

/** `mfw create`: returns the exit code. `rawArgs` are the arguments after
 * `create` as typed, for a relaunch. */
async function create(args: CreateArgs, rawArgs: string[], relaunch: Relaunch, globalInstall: boolean, run: Run): Promise<number> {
  const relaunched = await relaunchIfStale(rawArgs, relaunch, globalInstall);
  if (relaunched !== undefined) return relaunched;
  // The folder is created in kebab case, only its own name: the parent path is
  // taken as typed. Its name is also the app name's default.
  const typed = resolve(args.dir);
  const folder = kebabCase(basename(typed));
  if (folder === "") {
    throw new Error(`"${basename(typed)}" has no letters or digits to name a folder with`);
  }
  const dir = join(dirname(typed), folder);
  // What the command line already settles is checked before any question, so
  // the wizard is never answered for nothing. The HTTP channel and its auth
  // provider are paired here only with --yes: otherwise the wizard asks.
  const early =
    targetError(dir) ??
    selectionError(args.channels ?? [], args.plugins ?? [], args.auth) ??
    (args.yes ? pairingError(args.channels ?? [], args.auth) : undefined) ??
    remoteError(args);
  if (early !== undefined) {
    throw new Error(early);
  }
  const answers = args.yes ? answersFromFlags(args, folder) : await askAnswers(args, dir);
  if (answers === undefined) {
    return 1;
  }
  const chosen = CATALOG.filter((e) =>
    e.kind === "auth" ? e.id === answers.auth : (e.kind === "channel" ? answers.channels : answers.plugins).includes(e.id),
  ).map((e) => e.package);
  const versions = await appVersions(chosen, { registry: registryFrom(process.env.MFW_REGISTRY) });
  writeApp(dir, renderApp({ ...answers, versions }));
  const none = (ids: string[]) => (ids.length > 0 ? ids.join(", ") : "none");
  const report = await finishApp(
    dir,
    {
      install: args.install,
      git: args.git,
      ...(answers.gitRemote !== undefined ? { remote: answers.gitRemote } : {}),
      commitMessage: [
        `Scaffold with mfw create ${cliVersion()}`,
        `Channels: ${none(answers.channels)}\nPlugins: ${none(answers.plugins)}${answers.auth !== undefined ? `\nAuth: ${answers.auth}` : ""}`,
      ],
    },
    run,
  );
  process.stdout.write(finishMessage({ name: answers.name, dir, remote: answers.gitRemote, report }));
  return 0;
}

/** `mfw upgrade`: installs the registry's latest `@mercury-fw/cli` globally
 * when it's newer than this one; returns the install's exit code, 0 when
 * there's nothing newer, 1 when the registry can't answer. */
async function upgrade(relaunch: Relaunch): Promise<number> {
  const registry = registryFrom(process.env.MFW_REGISTRY).replace(/\/+$/, "");
  let newer: string | undefined;
  try {
    newer = await newerCli({ registry });
  } catch (err) {
    console.error(`couldn't check for a newer mfw: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (newer === undefined) {
    console.log(`mfw ${cliVersion()} is the latest.`);
    return 0;
  }
  const code = await relaunch(["bun", "add", "-g", `@mercury-fw/cli@${newer}`], { NPM_CONFIG_REGISTRY: registry });
  if (code === 0) console.log(`mfw upgraded from ${cliVersion()} to ${newer}.`);
  return code;
}

/** The commands that belong to the CLI itself, wherever it runs: never
 * handed over to an app's CLI. */
const OWN_COMMANDS = new Set(["create", "upgrade"]);

/** Inside an app whose own CLI (its devDependency) is installed at another
 * version than this one, as a global `mfw` can be, runs `argv` through that
 * CLI and returns its exit code: the app's commands then always match the
 * framework the app runs. `undefined` means run here: not an app command, not
 * inside an app, the app not installed yet, the same version, or already
 * handed over (`MFW_DEFERRED`). */
async function handOverToAppCli(argv: string[], cwd: string, relaunch: Relaunch): Promise<number | undefined> {
  const command = argv[0];
  if (command === undefined || command.startsWith("-") || OWN_COMMANDS.has(command)) return undefined;
  if (process.env.MFW_DEFERRED) return undefined;
  let app: App;
  try {
    app = findApp(cwd);
  } catch {
    return undefined;
  }
  const local = join(app.dir, "node_modules", "@mercury-fw", "cli");
  const manifest = join(local, "package.json");
  if (!existsSync(manifest)) return undefined;
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(manifest, "utf-8")) as { version?: unknown } | null)?.version;
  } catch (err) {
    console.error(`couldn't read the app's mfw (${manifest}): ${err instanceof Error ? err.message : String(err)}; running mfw ${cliVersion()}`);
    return undefined;
  }
  if (typeof version !== "string" || version === cliVersion()) return undefined;
  console.error(`mfw ${cliVersion()}: running the app's ${version}`);
  try {
    return await relaunch(["bun", join(local, "src", "bin.ts"), ...argv], { MFW_DEFERRED: "1" });
  } catch (err) {
    console.error(`couldn't run the app's mfw: ${err instanceof Error ? err.message : String(err)}; running mfw ${cliVersion()}`);
    return undefined;
  }
}

/** Runs `mfw` with `argv` (the arguments after the command name) and returns
 * the exit code, printing to stdout/stderr. `bin.ts` and `create-mercury-agent`
 * both call it; the app commands look for the app from `cwd` and run docker
 * through `deps`; `relaunch` is how `create` hands over to a newer CLI. */
export async function main(
  argv: string[],
  {
    cwd = process.cwd(),
    deps,
    relaunch = spawnRelaunch,
    globalInstall = isGlobalInstall(),
    run = spawnRun,
  }: { cwd?: string; deps?: AppDeps; relaunch?: Relaunch; globalInstall?: boolean; run?: Run } = {},
): Promise<number> {
  const handedOver = await handOverToAppCli(argv, cwd, relaunch);
  if (handedOver !== undefined) return handedOver;
  const rawCreateArgs = argv.slice(argv.indexOf("create") + 1);
  return runProgram(argv, {
    create: (args) => create(args, rawCreateArgs, relaunch, globalInstall, run),
    upgrade: () => upgrade(relaunch),
    app: () => appCommands(findApp(cwd), deps ?? terminalDeps()),
  });
}
