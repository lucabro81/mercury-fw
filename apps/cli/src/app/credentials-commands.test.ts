/**
 * `mfw credentials setup|check|reset` on a temporary app (a manifest with the
 * jira plugin, a third-party plugin and one keeping its login outside
 * ~/.config among its dependencies, each declaring its CLI login in its
 * installed package.json): the docker calls that run the declared commands
 * inside the app's container, where the CLI writes onto the credentials volume.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCommands, type AppDeps } from "./commands.ts";

let base: string;
let app: { dir: string; name: string };
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mercury-credentials-cmd-"));
  app = { dir: join(base, "my-agent"), name: "my-agent" };
  mkdirSync(app.dir);
  writeFileSync(
    join(app.dir, "package.json"),
    JSON.stringify({
      name: "my-agent",
      dependencies: {
        "@mercury-fw/core": "^0.26.0",
        "@mercury-fw/plugin-jira": "^0.1.0",
        "acme-mercury-plugin": "^1.0.0",
        "cloudy-plugin": "^2.0.0",
      },
    }),
  );
  installed("@mercury-fw/core", {});
  installed("@mercury-fw/plugin-jira", {
    mercury: {
      cliCredentials: { folder: "jira-cli", setup: ["jira", "init"], check: ["jira", "doctor"], logout: ["jira", "auth", "logout"] },
    },
  });
  // Not in the CLI's catalog: the declaration alone is what makes it work. It
  // declares neither a check nor a logout.
  installed("acme-mercury-plugin", { mercury: { cliCredentials: { folder: "acme-cli", setup: ["acme", "login"] } } });
  // A CLI that keeps its login outside ~/.config.
  installed("cloudy-plugin", {
    mercury: { cliCredentials: { path: ".cloudy", setup: ["cloudy", "init"], check: ["cloudy", "status"], logout: ["cloudy", "logout"] } },
  });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Writes `node_modules/<name>/package.json` in the app. */
function installed(name: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(app.dir, "node_modules", name), { recursive: true });
  writeFileSync(join(app.dir, "node_modules", name, "package.json"), JSON.stringify({ name, ...manifest }));
}

/** Deps that record docker calls, the printed lines, and answer `answer`. */
function fake({ answer = "", codes = [] as number[] } = {}) {
  const runs: string[][] = [];
  const printed: string[] = [];
  const asked: string[] = [];
  const deps: AppDeps = {
    run: async (argv) => {
      runs.push(argv);
      return codes.shift() ?? 0;
    },
    capture: async () => "",
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    print: (line) => void printed.push(line),
    home: join(base, "home"),
  };
  return { deps, runs, printed, asked };
}

const RUN = ["docker", "compose", "run", "--rm", "--no-deps"];

/** How a login kept outside ~/.config is reached by a one-off container: the
 * home path linked to the volume first, as the core does at startup. */
const LINKED = [
  "sh",
  "-c",
  'mkdir -p "$1" "$(dirname "$2")" && ln -sfn "$1" "$2" && shift 2 && exec "$@"',
  "sh",
  "/home/mercury/.config/mercury-home/.cloudy",
  "/home/mercury/.cloudy",
];

describe("credentials setup", () => {
  test.each(["jira-cli", "@mercury-fw/plugin-jira"])(
    "named %p: runs the declared setup in the app's container, on the terminal",
    async (plugin) => {
      const f = fake();
      expect(await appCommands(app, f.deps).credentialsSetup(plugin)).toBe(0);
      expect(f.runs).toEqual([[...RUN, "mercury", "jira", "init"]]);
      expect(f.printed).toEqual(["Next: mfw credentials check @mercury-fw/plugin-jira"]);
    },
  );

  test("a plugin outside the CLI's catalog works the same, through its declaration", async () => {
    const f = fake();
    expect(await appCommands(app, f.deps).credentialsSetup("acme-mercury-plugin")).toBe(0);
    expect(f.runs).toEqual([[...RUN, "mercury", "acme", "login"]]);
    expect(f.printed).toEqual([]);
  });

  // #144: a login kept outside ~/.config is written through the link onto the volume.
  test("a login declared elsewhere in the home is linked to the volume before the setup runs", async () => {
    const f = fake();
    expect(await appCommands(app, f.deps).credentialsSetup("cloudy-plugin")).toBe(0);
    expect(f.runs).toEqual([[...RUN, "mercury", ...LINKED, "cloudy", "init"]]);
  });

  test("a failed setup returns its exit code and suggests nothing", async () => {
    const f = fake({ codes: [2] });
    expect(await appCommands(app, f.deps).credentialsSetup("jira-cli")).toBe(2);
    expect(f.printed).toEqual([]);
  });

  // The short catalog name ("jira") isn't a name a third-party plugin has to
  // follow, so it isn't accepted.
  test.each(["jira", "bitbucket"])("%p isn't a declared package or folder: an error listing what the app has", async (name) => {
    const f = fake();
    await expect(appCommands(app, f.deps).credentialsSetup(name)).rejects.toThrow(
      `my-agent has no CLI credentials named "${name}". It has: @mercury-fw/plugin-jira (jira-cli), acme-mercury-plugin (acme-cli), cloudy-plugin (.cloudy).`,
    );
    expect(f.runs).toEqual([]);
  });

  test("an app without its dependencies installed says to install them", async () => {
    rmSync(join(app.dir, "node_modules"), { recursive: true });
    const f = fake();
    await expect(appCommands(app, f.deps).credentialsSetup("jira-cli")).rejects.toThrow("run bun install");
  });

  // Review of #144: another dependency's problem made every name fail.
  test("another dependency's problem doesn't stop a plugin that's fine", async () => {
    rmSync(join(app.dir, "node_modules", "acme-mercury-plugin"), { recursive: true });
    const f = fake();
    expect(await appCommands(app, f.deps).credentialsSetup("jira-cli")).toBe(0);
  });
});

describe("credentials check", () => {
  test("runs the declared check in the app's container", async () => {
    const f = fake({ codes: [1] });
    expect(await appCommands(app, f.deps).credentialsCheck("@mercury-fw/plugin-jira")).toBe(1);
    expect(f.runs).toEqual([[...RUN, "-T", "mercury", "jira", "doctor"]]);
  });

  test("a login declared elsewhere is linked first", async () => {
    const f = fake();
    await appCommands(app, f.deps).credentialsCheck(".cloudy");
    expect(f.runs).toEqual([[...RUN, "-T", "mercury", ...LINKED, "cloudy", "status"]]);
  });

  test("a plugin declaring no check says so, and runs nothing", async () => {
    const f = fake();
    await expect(appCommands(app, f.deps).credentialsCheck("acme-mercury-plugin")).rejects.toThrow(
      "acme-mercury-plugin declares no command to check its CLI's login.",
    );
    expect(f.runs).toEqual([]);
  });
});

describe("credentials reset", () => {
  test.each(["jira-cli", "@mercury-fw/plugin-jira"])(
    "named %p, confirmed with the folder's name: logs the service identity out",
    async (plugin) => {
      const f = fake({ answer: "jira-cli" });
      expect(await appCommands(app, f.deps).credentialsReset(plugin, {})).toBe(0);
      expect(f.asked).toEqual([
        "This logs the service identity of @mercury-fw/plugin-jira's CLI out: commands that run as it fail until mfw credentials setup @mercury-fw/plugin-jira. Type the folder's name (jira-cli) to confirm: ",
      ]);
      expect(f.runs).toEqual([[...RUN, "-T", "mercury", "jira", "auth", "logout"]]);
    },
  );

  test("--user logs one person out, by the id the CLI knows them by", async () => {
    const f = fake({ answer: "jira-cli" });
    expect(await appCommands(app, f.deps).credentialsReset("jira-cli", { user: "oidc:Alice" })).toBe(0);
    expect(f.asked[0]).toStartWith("This logs oidc:Alice out of @mercury-fw/plugin-jira's CLI: they log in again the next time they need it.");
    const [last] = f.runs;
    expect(last?.slice(0, -1)).toEqual([...RUN, "-T", "mercury", "jira", "auth", "logout", "--user"]);
    expect(last?.at(-1)).toMatch(/^oidc:[0-9a-f]{32}$/);
  });

  test("--user with a key the CLIs accept as it is passes it unchanged", async () => {
    const f = fake({ answer: "jira-cli" });
    await appCommands(app, f.deps).credentialsReset("jira-cli", { user: "static:alice" });
    expect(f.runs).toEqual([[...RUN, "-T", "mercury", "jira", "auth", "logout", "--user", "static:alice"]]);
  });

  test.each(["", "y", "jira", "@mercury-fw/plugin-jira", "my-agent"])("answer %p: nothing runs, exit 1", async (answer) => {
    const f = fake({ answer });
    expect(await appCommands(app, f.deps).credentialsReset("@mercury-fw/plugin-jira", {})).toBe(1);
    expect(f.runs).toEqual([]);
    expect(f.printed).toEqual(["Not confirmed: nobody logged out."]);
  });

  test("a login declared elsewhere is linked first", async () => {
    const f = fake({ answer: ".cloudy" });
    expect(await appCommands(app, f.deps).credentialsReset("cloudy-plugin", {})).toBe(0);
    expect(f.runs).toEqual([[...RUN, "-T", "mercury", ...LINKED, "cloudy", "logout"]]);
  });

  test("a plugin declaring no logout says so before any question", async () => {
    const f = fake({ answer: "acme-cli" });
    await expect(appCommands(app, f.deps).credentialsReset("acme-mercury-plugin", {})).rejects.toThrow(
      "acme-mercury-plugin declares no command to log its CLI out.",
    );
    expect(f.asked).toEqual([]);
    expect(f.runs).toEqual([]);
  });

  test("a plugin the app doesn't have is refused before any question", async () => {
    const f = fake({ answer: "bitbucket" });
    await expect(appCommands(app, f.deps).credentialsReset("bitbucket", {})).rejects.toThrow('no CLI credentials named "bitbucket"');
    expect(f.asked).toEqual([]);
    expect(f.runs).toEqual([]);
  });
});
