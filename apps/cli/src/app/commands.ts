/**
 * The commands that operate an app (`mfw start`, `mfw vault`, …): each one is
 * a short sequence of `docker compose` calls run from the app's folder, so the
 * docker details live here and not in every app. The command line is parsed
 * and validated before any of this runs (`program.ts`); what runs a command is
 * injected (`AppDeps`), which is how the tests see the exact calls.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { appCliCredentials, volumePath, type CliCredentials } from "@mercury-fw/utils";
import { packCredentials, readServiceAccountKey, setEnvVar } from "./credentials.ts";
import type { App } from "./find-app.ts";
import { copyPacks, LOCAL_PACKS_DIR, readPacks, withLocalOverrides, withoutLocalOverrides } from "./local-packages.ts";
import { findTests, loadTest } from "../e2e/load.ts";
import { runE2e } from "../e2e/runner.ts";
import { openReplSession } from "../e2e/session.ts";
import { openHttpSession, surfaceUrlFromPs } from "../e2e/http-session.ts";

export type AppDeps = {
  /** Runs `argv` in `cwd` on the user's terminal (stdin, stdout, stderr) and returns its exit code. */
  run: (argv: string[], opts: { cwd: string }) => Promise<number>;
  /** Runs `argv` in `cwd` and returns its stdout; throws when it fails. */
  capture: (argv: string[], opts: { cwd: string }) => Promise<string>;
  /** Asks the user `question` and returns the answer as typed. */
  ask: (question: string) => Promise<string>;
  /** Tells the user something. */
  print: (line: string) => void;
  /** The user's home folder, where a CLI keeps its config (`~/.config/<cli>`). */
  home: string;
};

const COMPOSE = ["docker", "compose"];

/** The Google Chat channel's package, which `google-chat` commands require. */
const GOOGLE_CHAT_PACKAGE = "@mercury-fw/channel-google-chat";

/** The app's service, the one the image builds. */
const SERVICE = "mercury";

/** The core's maintenance CLIs, from the container's working directory (the
 * app's folder, where node_modules/@mercury-fw/core is). A path and not a bin:
 * a monorepo image installs before copying the sources, and Bun doesn't link a
 * bin whose file isn't there yet. The core moves in lockstep with this CLI. */
export const VAULT_CLI = "node_modules/@mercury-fw/core/src/wiki/vault-cli.ts";
export const MEMORY_CLI = "node_modules/@mercury-fw/core/src/memory/memory-cli.ts";

/** What `mfw reset` can wipe: the compose service using the volume, the
 * volume's key in the compose file, and how to say what's lost. */
export const RESET_TARGETS = {
  memory: { service: "qdrant", volume: "qdrant-data", what: "Layer-3 memory (every Qdrant collection)" },
  wiki: { service: SERVICE, volume: "wiki-vault", what: "the wiki vault (every note)" },
} as const;
export type ResetTarget = keyof typeof RESET_TARGETS;

/** How long one e2e turn may take: a local model on a long, tool-heavy turn is slow. */
const E2E_TURN_TIMEOUT_MS = 10 * 60_000;

/** Runs `argv` in `cwd`, returning its exit code and its output (stdout and stderr together). */
async function captureCode(argv: string[], cwd: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: stdout + stderr };
}

/** The compose calls that build and start the app; `recreate` restarts containers even when nothing changed. */
function startCalls(noCache: boolean, recreate: boolean): string[][] {
  const up = [...COMPOSE, "up", "-d", ...(noCache ? [] : ["--build"]), ...(recreate ? ["--force-recreate"] : [])];
  return noCache ? [[...COMPOSE, "build", "--no-cache"], up] : [up];
}

/** The commands bound to `app`, each returning its exit code. */
export function appCommands(app: App, deps: AppDeps) {
  /** Runs `calls` in order from the app's folder, stopping at the first that fails; returns its exit code, 0 if none did. */
  const runAll = async (calls: string[][]): Promise<number> => {
    for (const argv of calls) {
      const code = await deps.run(argv, { cwd: app.dir });
      if (code !== 0) return code;
    }
    return 0;
  };
  const oneOff = (argv: string[]) => runAll([[...COMPOSE, "run", "--rm", "-T", SERVICE, ...argv]]);
  /** The compose services running right now. */
  const running = async (): Promise<string[]> =>
    (await deps.capture([...COMPOSE, "ps", "--status", "running", "--services"], { cwd: app.dir }))
      .split("\n")
      .map((s) => s.trim());

  return {
    start: ({ noCache }: { noCache: boolean }) => runAll(startCalls(noCache, false)),
    restart: ({ noCache }: { noCache: boolean }) => runAll(startCalls(noCache, true)),
    stop: () => runAll([[...COMPOSE, "down"]]),
    logs: (service?: string) => runAll([[...COMPOSE, "logs", "-f", ...(service === undefined ? [] : [service])]]),
    repl: () => runAll([[...COMPOSE, "run", "--rm", SERVICE, "bun", "run", "repl"]]),
    shell: async () => {
      const shell = (await running()).includes(SERVICE) ? ["exec", SERVICE, "bash"] : ["run", "--rm", SERVICE, "bash"];
      return runAll([[...COMPOSE, ...shell]]);
    },
    /** `args` is the vault CLI's own command line (`list`, `read <path>`, …). */
    vault: (args: string[]) => oneOff(["bun", VAULT_CLI, ...args]),
    /** `args` is the memory CLI's own command line (`list`, `read <collection>`, …). */
    memory: (args: string[]) => oneOff(["bun", MEMORY_CLI, ...args]),
    /** Deletes `target`'s volume once the user types the app's name, then
     * brings its service back up on an empty volume. The volume's real name
     * comes from the compose file, and a wrong answer deletes nothing. */
    reset: async (target: ResetTarget) => {
      const { service, volume: key, what } = RESET_TARGETS[target];
      const config = JSON.parse(
        await deps.capture([...COMPOSE, "config", "--no-interpolate", "--format", "json"], { cwd: app.dir }),
      ) as { volumes?: Record<string, { name?: string }> };
      const volume = config.volumes?.[key]?.name;
      if (volume === undefined) {
        throw new Error(`The compose file has no "${key}" volume to reset`);
      }
      const answer = await deps.ask(`This deletes ${what} for good: volume ${volume}. Type the app's name (${app.name}) to confirm: `);
      if (answer.trim() !== app.name) {
        deps.print("Not confirmed: nothing deleted.");
        return 1;
      }
      const code = await stopped(service, [
        [...COMPOSE, "rm", "-f", service],
        ["docker", "volume", "rm", volume],
      ]);
      if (code !== 0) return code;
      // A running app sets up its Qdrant collections only when it starts.
      if (target === "memory" && (await running()).includes(SERVICE)) {
        return runAll([[...COMPOSE, "restart", SERVICE]]);
      }
      return 0;
    },
    /** Packs the plugin's CLI login folder (`from`, by default where the
     * plugin declares it under the home) into its credentials variable,
     * written into the app's env file, or printed with `print`. */
    credentialsSet: async (plugin: string, { from, print }: { from?: string; print: boolean }) => {
      const { name, path, variable } = credentialsOf(app, plugin);
      const source = resolve(from ?? join(deps.home, path));
      const value = await packCredentials(source, basename(path));
      if (print) {
        deps.print(`${variable}=${value}`);
        return 0;
      }
      const envFile = join(app.dir, ".env");
      setEnvVar(envFile, variable, value);
      deps.print(`${variable} set in ${envFile}, from ${source}.`);
      deps.print(
        `The app unpacks it at its next start, if the volume has no ${name} folder yet; if it has one, run mfw credentials reset ${name} first.`,
      );
      return 0;
    },
    /** Deletes the plugin's CLI folder from the credentials volume once the
     * user types the folder's name, so its variable is unpacked again at the
     * next start. A wrong answer deletes nothing. */
    credentialsReset: async (plugin: string) => {
      const { name, path } = credentialsOf(app, plugin);
      const answer = await deps.ask(
        `This deletes the ${name} folder from the app's credentials volume, and any token the CLI refreshed since it was unpacked. Type the folder's name (${name}) to confirm: `,
      );
      if (answer.trim() !== name) {
        deps.print("Not confirmed: nothing deleted.");
        return 1;
      }
      return stopped(SERVICE, [[...COMPOSE, "run", "--rm", "--no-deps", "-T", SERVICE, "rm", "-rf", `/home/mercury/${volumePath(path)}`]]);
    },
    /** Writes the Google Chat channel's service account key (the JSON file
     * at `keyFile`) into the app's env file, and the Pub/Sub subscription when
     * given. Everything is checked before anything is written; the key is
     * never printed. */
    googleChatSetKey: async (keyFile: string, { subscription }: { subscription?: string }) => {
      const manifest = JSON.parse(readFileSync(join(app.dir, "package.json"), "utf-8")) as {
        dependencies?: Record<string, string>;
      };
      if (manifest.dependencies?.[GOOGLE_CHAT_PACKAGE] === undefined) {
        throw new Error(`${app.name} doesn't have the Google Chat channel (${GOOGLE_CHAT_PACKAGE}) among its dependencies.`);
      }
      if (subscription !== undefined && !/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(subscription)) {
        throw new Error(`--subscription takes projects/<project>/subscriptions/<name> (got "${subscription}").`);
      }
      const source = resolve(keyFile);
      const { clientEmail, privateKey } = readServiceAccountKey(source);
      const envFile = join(app.dir, ".env");
      setEnvVar(envFile, "GOOGLE_CHAT_APP_CLIENT_EMAIL", clientEmail);
      setEnvVar(envFile, "GOOGLE_CHAT_APP_PRIVATE_KEY", privateKey);
      if (subscription !== undefined) setEnvVar(envFile, "GOOGLE_CHAT_PUBSUB_SUBSCRIPTION", subscription);
      const written =
        subscription === undefined
          ? "GOOGLE_CHAT_APP_CLIENT_EMAIL and GOOGLE_CHAT_APP_PRIVATE_KEY"
          : "GOOGLE_CHAT_APP_CLIENT_EMAIL, GOOGLE_CHAT_APP_PRIVATE_KEY and GOOGLE_CHAT_PUBSUB_SUBSCRIPTION";
      deps.print(`${written} set in ${envFile}, from ${source}.`);
      deps.print(`Delete ${source} now, the env file holds the key. mfw start applies it to a running app.`);
      return 0;
    },
    /** Makes the app install the packages in `from`'s tarballs (`bun pm
     * pack`) instead of the registry's: copied into `.packs/` (which the
     * image copies too), overridden in the manifest, then installed.
     * Everything is checked before anything is written. */
    localPackages: async (from: string) => {
      const packs = await readPacks(from, app.dir);
      const manifest = withLocalOverrides(readManifest(), packs);
      copyPacks(from, app.dir, packs);
      writeManifest(manifest);
      deps.print(`${packs.length} local packages in ${join(app.dir, LOCAL_PACKS_DIR)}: ${packs.map((p) => p.name).join(", ")}.`);
      return deps.run(["bun", "install"], { cwd: app.dir });
    },
    /** Runs e2e tests (`tests`, or the app's `e2e/*.e2e.ts`) against the app's
     * REPL in its container, or against its running service's HTTP surface for
     * a case on `http`, keeping the turns and checks in `e2e/results/<time>/`;
     * returns 1 when a case didn't pass. */
    e2e: async (tests: string[], { repeat }: { repeat?: number }) => {
      const files = findTests(tests, { appDir: app.dir, cwd: process.cwd() });
      const loaded = await Promise.all(files.map(async (file) => ({ file: relative(process.cwd(), file) || file, test: await loadTest(file) })));
      const results = join(app.dir, "e2e", "results", new Date().toISOString().replace(/[:.]/g, "-"));
      mkdirSync(results, { recursive: true });
      // The container's user writes the dumps here; on a Linux host it isn't
      // the folder's owner.
      chmodSync(results, 0o777);
      let sessions = 0;
      return runE2e(loaded, repeat === undefined ? {} : { repeat }, {
        openSession: async (channel) => {
          if (channel === "http") {
            // Where the running service publishes the surface, as compose reports it.
            const ps = await captureCode([...COMPOSE, "ps", "--format", "json", SERVICE], app.dir);
            const baseUrl = ps.code === 0 ? surfaceUrlFromPs(ps.output, SERVICE) : undefined;
            if (baseUrl === undefined) throw new Error("the app's service isn't running or publishes no HTTP port: mfw start");
            return openHttpSession({ baseUrl, timeoutMs: E2E_TURN_TIMEOUT_MS });
          }
          return openReplSession({
            argv: [...COMPOSE, "run", "--rm", "-T", "-v", `${results}:/e2e`, SERVICE, "bun", "run", "repl"],
            cwd: app.dir,
            hostDir: results,
            replDir: "/e2e",
            name: `run-${++sessions}`,
            timeoutMs: E2E_TURN_TIMEOUT_MS,
          });
        },
        cli: (command) => captureCode([...COMPOSE, "run", "--rm", "-T", "--no-deps", SERVICE, "sh", "-c", command], app.dir),
        appPackages: (readManifest() as { dependencies?: Record<string, string> }).dependencies ?? {},
        print: deps.print,
        now: Date.now,
        writeReport: async (report) => {
          writeFileSync(join(results, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
          deps.print(`Turns and checks in ${results}`);
        },
      });
    },
    /** Undoes `localPackages`: the app installs from the registry again. */
    localPackagesOff: async () => {
      writeManifest(withoutLocalOverrides(readManifest()));
      rmSync(join(app.dir, LOCAL_PACKS_DIR), { recursive: true, force: true });
      deps.print("Local packages removed: installing from the registry.");
      return deps.run(["bun", "install"], { cwd: app.dir });
    },
  };

  /** The app's manifest, as an object. */
  function readManifest(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(app.dir, "package.json"), "utf-8")) as Record<string, unknown>;
  }

  /** Writes the app's manifest, two-space indented like the one `mfw create` writes. */
  function writeManifest(manifest: Record<string, unknown>): void {
    writeFileSync(join(app.dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /** Stops `service`, runs `steps`, starts it again; stops at the first
   * failure and, once the service is stopped, says it's down and how to bring
   * it back. Returns the exit code. */
  async function stopped(service: string, steps: string[][]): Promise<number> {
    const all = [[...COMPOSE, "stop", service], ...steps, [...COMPOSE, "up", "-d", service]];
    for (const [i, argv] of all.entries()) {
      const code = await deps.run(argv, { cwd: app.dir });
      if (code === 0) continue;
      if (i > 0) deps.print(`The ${service} service was stopped and not restarted: mfw start brings it back.`);
      return code;
    }
    return 0;
  }
}

/** The CLI credentials `plugin` names, by package or by folder, among those
 * the app's dependencies declare; throws naming the ones it has otherwise,
 * with the dependencies it couldn't read. */
function credentialsOf(app: App, plugin: string): CliCredentials {
  const { declared, problems } = appCliCredentials(app.dir);
  const found = declared.find((c) => c.package === plugin || c.name === plugin);
  if (found === undefined) {
    const have = declared.map((c) => `${c.package} (${c.name})`).join(", ") || "none";
    const unread = problems.length > 0 ? ` Left out: ${problems.join("; ")}.` : "";
    throw new Error(`${app.name} has no CLI credentials named "${plugin}". It has: ${have}.${unread}`);
  }
  return found;
}

/** The real deps: docker on the user's terminal, questions on `input`
 * (stdin by default). */
export function terminalDeps({
  input = process.stdin,
  output = process.stdout,
}: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): AppDeps {
  return {
    run: async (argv, { cwd }) => {
      const proc = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return await proc.exited;
    },
    capture: async (argv, { cwd }) => {
      const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) throw new Error(`${argv.join(" ")} failed (exit ${code})`);
      return out;
    },
    // Input closing before a line (Ctrl+D, `< /dev/null`) is an empty answer,
    // never a question left waiting.
    ask: async (question) => {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input, output });
      return await new Promise<string>((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question(question, (answer) => {
          resolve(answer);
          rl.close();
        });
      });
    },
    print: (line) => console.log(line),
    home: homedir(),
  };
}
