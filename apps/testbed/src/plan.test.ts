/**
 * What `bun run create` does for a given command line: the steps, in order,
 * from packing the workspaces to the app installing them. Running them is
 * `create.ts`; this is only the plan, so the decisions are tested without
 * spawning anything.
 */
import { describe, expect, test } from "bun:test";
import { parseCreateArgs, planCreate } from "./plan.ts";

const ROOT = "/repo/apps/testbed";

describe("parseCreateArgs", () => {
  test("name, plugins, channels, fresh", () => {
    expect(parseCreateArgs(["prova", "--plugins", "jira, bitbucket", "--channels", "http", "--fresh"])).toEqual({
      name: "prova",
      plugins: ["jira", "bitbucket"],
      channels: ["http"],
      fresh: true,
    });
  });

  test("--auth: the HTTP channel's auth provider", () => {
    expect(parseCreateArgs(["prova", "--channels", "http", "--auth", "oidc"])).toEqual({ name: "prova", channels: ["http"], auth: "oidc", fresh: false });
  });

  test("--from: a test file whose plugins and channels the app gets", () => {
    expect(parseCreateArgs(["prova", "--from", "tests/jira.e2e.ts"])).toEqual({ name: "prova", from: "tests/jira.e2e.ts", fresh: false });
  });

  test("a name that isn't a folder name, or none at all, is an error", () => {
    expect(() => parseCreateArgs([])).toThrow("usage: bun run create <name>");
    expect(() => parseCreateArgs(["../escape"])).toThrow('"../escape" isn\'t a folder name');
  });

  test("an unknown flag or a second name is an error", () => {
    expect(() => parseCreateArgs(["prova", "--plugin", "jira"])).toThrow("--plugin");
    expect(() => parseCreateArgs(["prova", "other"])).toThrow("usage: bun run create <name>");
  });

  test("--from with --plugins or --channels is an error: the test says what the app has", () => {
    expect(() => parseCreateArgs(["prova", "--from", "t.e2e.ts", "--plugins", "jira"])).toThrow("--from takes the plugins and channels from the test");
  });
});

describe("planCreate", () => {
  test("a new app: pack, create it with the CLI of this repo, then install the tarballs", () => {
    expect(planCreate({ name: "prova", plugins: ["jira"], channels: ["http"], fresh: false }, { root: ROOT, exists: false })).toEqual([
      { step: "pack" },
      { step: "run", argv: ["mfw", "create", "apps/prova", "--plugins", "jira", "--channels", "http", "--auth", "static", "--no-install", "--yes"], cwd: ROOT },
      { step: "run", argv: ["mfw", "local-packages", "../../.packs"], cwd: `${ROOT}/apps/prova` },
    ]);
  });

  // #37: the HTTP channel doesn't start without an auth provider; in the test
  // bed the static one, whose test tokens make two users, unless told otherwise.
  test("the HTTP channel gets the static auth provider, or the one given", () => {
    const create = (args: { channels?: string[]; auth?: string }) =>
      (planCreate({ name: "prova", fresh: false, ...args }, { root: ROOT, exists: false })[1] as { argv: string[] }).argv;
    expect(create({ channels: ["http"] })).toContain("--auth");
    expect(create({ channels: ["http"] }).slice(-4)).toEqual(["--auth", "static", "--no-install", "--yes"]);
    expect(create({ channels: ["http"], auth: "oidc" }).slice(-4)).toEqual(["--auth", "oidc", "--no-install", "--yes"]);
    expect(create({ channels: ["google-chat"] })).not.toContain("--auth");
  });

  test("nothing chosen: an app with neither, as mfw create makes it", () => {
    const plan = planCreate({ name: "prova", fresh: false }, { root: ROOT, exists: false });
    expect(plan[1]).toEqual({ step: "run", argv: ["mfw", "create", "apps/prova", "--plugins", "", "--channels", "", "--no-install", "--yes"], cwd: ROOT });
  });

  test("an app that exists: only pack and install again, keeping its config, persona and .env", () => {
    expect(planCreate({ name: "prova", fresh: false }, { root: ROOT, exists: true })).toEqual([
      { step: "pack" },
      { step: "run", argv: ["mfw", "local-packages", "../../.packs"], cwd: `${ROOT}/apps/prova` },
    ]);
  });

  // #140 review: on an existing app the flags were dropped without a word.
  test("plugins, channels or a test given for an app that exists: a warning first, its config stays", () => {
    for (const given of [{ plugins: ["bitbucket"] }, { channels: ["http"] }, { from: "tests/x.e2e.ts", plugins: [] }]) {
      const plan = planCreate({ name: "prova", fresh: false, ...given }, { root: ROOT, exists: true });
      expect(plan[0]).toEqual({
        step: "warn",
        message: `${ROOT}/apps/prova exists: its plugins and channels stay as they are (--fresh makes it anew with the ones given)`,
      });
      expect(plan.slice(1).map((s) => s.step)).toEqual(["pack", "run"]);
    }
    expect(planCreate({ name: "prova", fresh: false }, { root: ROOT, exists: true })[0]).toEqual({ step: "pack" });
  });

  test("--fresh on an app that doesn't exist: nothing to remove", () => {
    expect(planCreate({ name: "prova", plugins: ["jira"], fresh: true }, { root: ROOT, exists: false }).map((s) => s.step)).toEqual(["pack", "run", "run"]);
  });

  test("--fresh on an app that exists: removed first, then made anew", () => {
    const plan = planCreate({ name: "prova", plugins: ["jira"], fresh: true }, { root: ROOT, exists: true });
    expect(plan.map((s) => (s.step === "run" ? s.argv.slice(0, 2).join(" ") : s.step))).toEqual(["remove", "pack", "mfw create", "mfw local-packages"]);
    expect(plan[0]).toEqual({ step: "remove", dir: `${ROOT}/apps/prova` });
  });
});
