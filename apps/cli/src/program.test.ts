/**
 * The `mfw` command line (commander): what each command line reaches, with
 * which arguments, and what's refused before anything runs. `create` and the
 * app commands are fakes here; their behaviour has its own tests.
 */
import { describe, expect, test } from "bun:test";
import type { CreateArgs } from "./args.ts";
import { runProgram, type AppCommands } from "./program.ts";

/** Handlers that record what they receive, and captured output. */
function harness({ code = 0, appError }: { code?: number; appError?: string } = {}) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return code;
    };
  const app: AppCommands = {
    start: record("start"),
    restart: record("restart"),
    stop: record("stop"),
    logs: record("logs"),
    repl: record("repl"),
    shell: record("shell"),
    vault: record("vault"),
    memory: record("memory"),
    reset: record("reset"),
    credentialsSetup: record("credentialsSetup"),
    credentialsCheck: record("credentialsCheck"),
    credentialsReset: record("credentialsReset"),
    googleChatSetKey: record("googleChatSetKey"),
    localPackages: record("localPackages"),
    localPackagesOff: record("localPackagesOff"),
    e2e: record("e2e"),
  };
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    runProgram(
      argv,
      {
        create: async (args: CreateArgs) => {
          calls.push(["create", args]);
          return code;
        },
        upgrade: async () => {
          calls.push(["upgrade"]);
          return code;
        },
        app: () => {
          if (appError !== undefined) throw new Error(appError);
          return app;
        },
      },
      { writeOut: (s) => void out.push(s), writeErr: (s) => void err.push(s) },
    );
  return { run, calls, out: () => out.join(""), err: () => err.join("") };
}

describe("create", () => {
  test("the folder alone: nothing answered, wizard not skipped", async () => {
    const h = harness();
    expect(await h.run("create", "my-app")).toBe(0);
    expect(h.calls).toEqual([["create", { dir: "my-app", yes: false, install: true, git: true }]]);
  });

  test("every flag", async () => {
    const h = harness();
    await h.run(
      "create",
      "apps/demo",
      "--name",
      "demo",
      "--assistant-name",
      "Hermes",
      "--role",
      "the release assistant",
      "--channels",
      "http,google-chat",
      "--plugins",
      "jira",
      "--auth",
      "static",
      "--directory",
      "zitadel",
      "--git-remote",
      "git@example.com:acme/demo.git",
      "--yes",
    );
    expect(h.calls).toEqual([
      [
        "create",
        {
          dir: "apps/demo",
          name: "demo",
          assistantName: "Hermes",
          role: "the release assistant",
          channels: ["http", "google-chat"],
          plugins: ["jira"],
          auth: "static",
          directory: "zitadel",
          gitRemote: "git@example.com:acme/demo.git",
          yes: true,
          install: true,
          git: true,
        },
      ],
    ]);
  });

  test("lists tolerate spaces and empty items; an empty list means none", async () => {
    const h = harness();
    await h.run("create", "d", "--channels", " http , ", "--plugins", "");
    expect(h.calls[0]?.[1]).toMatchObject({ channels: ["http"], plugins: [] });
  });

  test("--local-packages: the folder of tarballs, as typed", async () => {
    const h = harness();
    await h.run("create", "d", "--local-packages", "../.packs");
    expect(h.calls[0]?.[1]).toMatchObject({ localPackages: "../.packs" });
  });

  test("--no-install and --no-git turn the steps after writing off", async () => {
    const h = harness();
    await h.run("create", "d", "--no-install", "--no-git");
    expect(h.calls[0]?.[1]).toMatchObject({ install: false, git: false });
  });

  test("a blank --git-remote is no remote", async () => {
    const h = harness();
    await h.run("create", "d", "--git-remote", "  ");
    expect(h.calls[0]?.[1]).not.toHaveProperty("gitRemote");
  });

  test("-y is --yes", async () => {
    const h = harness();
    await h.run("create", "d", "-y");
    expect((h.calls[0]?.[1] as CreateArgs).yes).toBe(true);
  });

  test.each([
    [[], "missing required argument 'folder'"],
    [["a", "b"], "too many arguments"],
    [["d", "--frobnicate"], "unknown option '--frobnicate'"],
  ])("create %p is refused: %s", async (args, message) => {
    const h = harness();
    expect(await h.run("create", ...args)).toBe(1);
    expect(h.err()).toContain(message);
    expect(h.calls).toEqual([]);
  });

  test("create's exit code comes back", async () => {
    expect(await harness({ code: 3 }).run("create", "d")).toBe(3);
  });
});

describe("app commands reach the app with their arguments", () => {
  test.each([
    [["start"], ["start", { noCache: false }]],
    [["start", "--no-cache"], ["start", { noCache: true }]],
    [["restart"], ["restart", { noCache: false }]],
    [["restart", "--no-cache"], ["restart", { noCache: true }]],
    [["stop"], ["stop"]],
    [["logs"], ["logs", undefined]],
    [["logs", "qdrant"], ["logs", "qdrant"]],
    [["repl"], ["repl"]],
    [["shell"], ["shell"]],
    [["reset", "memory"], ["reset", "memory"]],
    [["reset", "wiki"], ["reset", "wiki"]],
    [["vault", "list"], ["vault", ["list"]]],
    [["vault", "read", "curated/x.md"], ["vault", ["read", "curated/x.md"]]],
    [["vault", "grep", "story points"], ["vault", ["grep", "story points"]]],
    [["vault", "write-curated", "curated/x.md"], ["vault", ["write-curated", "curated/x.md"]]],
    [["vault", "write-curated", "curated/x.md", "--author", "luca"], ["vault", ["write-curated", "curated/x.md", "--author", "luca"]]],
    [["vault", "write-raw", "raw/x.md"], ["vault", ["write-raw", "raw/x.md"]]],
    [["memory", "list"], ["memory", ["list"]]],
    [["memory", "read", "episodic_memory"], ["memory", ["read", "episodic_memory"]]],
    [["memory", "read", "episodic_memory", "--limit", "5"], ["memory", ["read", "episodic_memory", "--limit", "5"]]],
    [["credentials", "setup", "jira-cli"], ["credentialsSetup", "jira-cli", {}]],
    [["credentials", "setup", "jira-cli", "--user-app"], ["credentialsSetup", "jira-cli", { userApp: true }]],
    [["credentials", "check", "@mercury-fw/plugin-jira"], ["credentialsCheck", "@mercury-fw/plugin-jira"]],
    [["credentials", "reset", "jira-cli"], ["credentialsReset", "jira-cli", {}]],
    [["credentials", "reset", "jira-cli", "--user", "oidc:123"], ["credentialsReset", "jira-cli", { user: "oidc:123" }]],
    [["google-chat", "set-key", "key.json"], ["googleChatSetKey", "key.json", {}]],
    [
      ["google-chat", "set-key", "key.json", "--subscription", "projects/p/subscriptions/s"],
      ["googleChatSetKey", "key.json", { subscription: "projects/p/subscriptions/s" }],
    ],
    [["local-packages", "../../.packs"], ["localPackages", "../../.packs"]],
    [["local-packages", "--off"], ["localPackagesOff"]],
    [["e2e"], ["e2e", [], {}]],
    [["e2e", "a.e2e.ts", "b.e2e.ts", "--repeat", "3"], ["e2e", ["a.e2e.ts", "b.e2e.ts"], { repeat: 3 }]],
  ])("mfw %p", async (argv, call) => {
    const h = harness();
    expect(await h.run(...argv)).toBe(0);
    expect(h.calls).toEqual([call]);
  });

  // Regression: -h anywhere on the line was taken as a request for help, so
  // searching the vault for "-h" printed the help instead.
  test("after --, a value that looks like a flag is passed as it is", async () => {
    const h = harness();
    await h.run("vault", "grep", "--", "-h");
    expect(h.calls).toEqual([["vault", ["grep", "-h"]]]);
  });

  test("the app command's exit code comes back", async () => {
    expect(await harness({ code: 2 }).run("vault", "read", "missing.md")).toBe(2);
  });

  test("outside an app: the error, exit 1", async () => {
    const h = harness({ appError: "Not inside a Mercury app: no mercury.config.ts in /tmp" });
    expect(await h.run("start")).toBe(1);
    expect(h.err()).toContain("Not inside a Mercury app");
  });
});

describe("refused before anything runs", () => {
  test.each([
    [["start", "--nocache"], "unknown option '--nocache'"],
    [["logs", "mercury", "qdrant"], "too many arguments"],
    [["logs", "--tail", "10"], "unknown option '--tail'"],
    [["reset"], "missing required argument 'target'"],
    [["reset", "everything"], "Allowed choices are memory, wiki"],
    [["reset", "wiki", "memory"], "too many arguments"],
    [["vault", "lst"], "unknown command 'lst'"],
    [["vault", "read"], "missing required argument 'path'"],
    [["memory", "read"], "missing required argument 'collection'"],
    [["memory", "read", "x", "--limit", "0"], "--limit takes a positive whole number"],
    [["memory", "read", "x", "--limit", "ten"], "--limit takes a positive whole number"],
    [["memory", "list", "--limit", "5"], "unknown option '--limit'"],
    [["deploy"], "unknown command 'deploy'"],
    [["credentials", "setup"], "missing required argument 'plugin'"],
    [["credentials", "setup", "jira", "--from", "/x"], "unknown option '--from'"],
    [["credentials", "set", "jira"], "unknown command 'set'"],
    [["credentials", "reset", "jira", "bitbucket"], "too many arguments"],
    [["credentials", "copy", "jira"], "unknown command 'copy'"],
    [["google-chat", "set-key"], "missing required argument 'key-file'"],
    [["google-chat", "set-key", "key.json", "--subscription"], "option '--subscription <name>' argument missing"],
    [["google-chat", "set-key", "a.json", "b.json"], "too many arguments"],
    [["local-packages"], "local-packages takes a folder of tarballs, or --off"],
    [["local-packages", "x", "--off"], "local-packages takes a folder of tarballs, or --off"],
    [["local-packages", "a", "b"], "too many arguments"],
    [["e2e", "--repeat", "0"], "--repeat takes a positive whole number"],
    [["e2e", "--repeat", "ten"], "--repeat takes a positive whole number"],
  ])("mfw %p: %s", async (argv, message) => {
    const h = harness();
    expect(await h.run(...argv)).toBe(1);
    expect(h.err()).toContain(message);
    expect(h.calls).toEqual([]);
  });

  test("a typo suggests the command", async () => {
    const h = harness();
    await h.run("strat");
    expect(h.err()).toContain("Did you mean start?");
  });

  test("no command prints the help and exits 1", async () => {
    const h = harness();
    expect(await h.run()).toBe(1);
    expect(h.err()).toContain("Usage: mfw");
  });
});

describe("help", () => {
  const COMMANDS = ["create", "start", "stop", "restart", "logs", "repl", "shell", "vault", "memory", "reset", "credentials", "google-chat", "local-packages", "e2e", "upgrade"];

  test("--help lists every command, exit 0", async () => {
    const h = harness();
    expect(await h.run("--help")).toBe(0);
    for (const c of COMMANDS) expect(h.out()).toContain(`  ${c}`);
  });

  test.each([...COMMANDS.map((c) => [c]), ["vault", "write-curated"], ["memory", "read"], ["credentials", "setup"], ["credentials", "check"], ["credentials", "reset"], ["google-chat", "set-key"]])(
    "mfw %s … --help describes it and runs nothing",
    async (...path) => {
      const h = harness();
      expect(await h.run(...path, "--help")).toBe(0);
      expect(h.out()).toContain(`Usage: mfw ${path.join(" ")}`);
      expect(h.calls).toEqual([]);
    },
  );
});

describe("upgrade", () => {
  test("mfw upgrade runs the upgrade, outside an app too", async () => {
    const h = harness({ appError: "Not inside a Mercury app" });
    expect(await h.run("upgrade")).toBe(0);
    expect(h.calls).toEqual([["upgrade"]]);
  });

  test("takes no arguments", async () => {
    const h = harness();
    expect(await h.run("upgrade", "0.30.0")).toBe(1);
    expect(h.err()).toContain("too many arguments");
    expect(h.calls).toEqual([]);
  });
});
