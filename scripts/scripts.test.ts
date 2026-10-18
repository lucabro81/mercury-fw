/**
 * The release scripts' decisions, tested apart from the registry and git: the
 * order packages are built and published in, what counts as "already
 * published", what a pack may and may not contain, and whether there is
 * anything to release.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderByDependencies, REPO_ONLY_DIRS, workspaces, type Workspace } from "./workspaces.ts";
import { typesConfig } from "./build-types.ts";
import { isPublished, publishAction, publishCommand } from "./publish.ts";
import { comparePack } from "./check-pack.ts";
import { pendingChangesets, stageRelease } from "./release.ts";

const ws = (name: string, deps: Record<string, string> = {}, peers: Record<string, string> = {}): Workspace => ({
  dir: `/repo/${name}`,
  pkg: { name, version: "1.0.0", dependencies: deps, peerDependencies: peers },
});

describe("orderByDependencies", () => {
  test("every workspace comes after the ones it depends on, peers included", () => {
    const order = orderByDependencies([
      ws("plugin", {}, { contract: "*", engine: "*" }),
      ws("core", { contract: "*", engine: "*" }),
      ws("engine", { contract: "*" }),
      ws("contract"),
    ]).map((w) => w.pkg.name);
    expect(order).toEqual(["contract", "engine", "plugin", "core"]);
  });

  test("dependencies outside the set are ignored, each workspace appears once", () => {
    const order = orderByDependencies([ws("a", { zod: "^4" }), ws("b", { a: "*" }), ws("a2", { a: "*", b: "*" })]);
    expect(order.map((w) => w.pkg.name)).toEqual(["a", "b", "a2"]);
  });
});

describe("isPublished", () => {
  const reply = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;

  test("200 means published, 404 means not", async () => {
    expect(await isPublished("@mercury-fw/core", "0.25.0", "https://r.test", reply(200))).toBe(true);
    expect(await isPublished("@mercury-fw/core", "0.25.0", "https://r.test", reply(404))).toBe(false);
  });

  // Regression: any non-2xx counted as "not published", so an auth error or an
  // outage made the script try to publish a version that already exists.
  test.each([401, 403, 429, 500, 503])("a %p stops everything instead of guessing", async (status) => {
    await expect(isPublished("@mercury-fw/core", "0.25.0", "https://r.test", reply(status))).rejects.toThrow(
      `${status}`,
    );
  });

  test("an unreachable registry is an error that says so", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(isPublished("@mercury-fw/core", "0.25.0", "https://r.test", down)).rejects.toThrow(
      "Can't reach https://r.test",
    );
  });

  test("asks for the scoped name encoded", async () => {
    let asked = "";
    const fetchFn = (async (url: string) => {
      asked = url;
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await isPublished("@mercury-fw/core", "0.25.0", "https://r.test", fetchFn);
    expect(asked).toBe("https://r.test/@mercury-fw%2Fcore/0.25.0");
  });
});

describe("comparePack", () => {
  test("a pack with exactly the expected files has no problems", () => {
    expect(comparePack("p", new Set(["package.json", "index.ts"]), new Set(["package.json", "index.ts"]))).toEqual([]);
  });

  test("a missing file and a leaked one are both reported", () => {
    expect(
      comparePack("p", new Set(["package.json", "index.ts", "jira.json"]), new Set(["package.json", "index.ts", "bin/jira"])),
    ).toEqual(["p: missing from the pack: jira.json", "p: shouldn't be in the pack: bin/jira"]);
  });
});

describe("pendingChangesets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "changesets-"));
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "README.md"), "# Changesets");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the README and the config aren't changesets", () => {
    expect(pendingChangesets(dir)).toEqual([]);
  });

  test("every other Markdown file is one", () => {
    writeFileSync(join(dir, "brave-cats-sing.md"), "---\n---\n");
    expect(pendingChangesets(dir)).toEqual(["brave-cats-sing.md"]);
  });
});

// Regression: releases write a CHANGELOG.md into each package, but the `files`
// whitelists left it out, so the pack check stopped the first CI publish.
describe("every public package ships its changelog", () => {
  test.each(workspaces().filter((w) => !w.pkg.private).map((w) => [w.pkg.name, w] as const))("%s", (_name, w) => {
    const files = (w.pkg as { files?: string[] }).files ?? [];
    expect(files).toContain("CHANGELOG.md");
  });
});

// Regression (#257): merging a brand-new package put it on main at 0.0.0, and
// publish.ts tried to publish that, which failed (no trusted publisher yet)
// and turned the CI run red.
describe("publishAction", () => {
  const at = (version: string) => ({ name: "@mercury-fw/plugin-new", version });

  test("a workspace at 0.0.0 is skipped as unreleased, without asking the registry", async () => {
    let asked = false;
    const published = async () => {
      asked = true;
      return false;
    };
    expect(await publishAction(at("0.0.0"), "https://r.test", published)).toEqual({ publish: false, reason: "not released yet" });
    expect(asked).toBe(false);
  });

  test("a version already on the registry is skipped, saying where", async () => {
    expect(await publishAction(at("0.1.0"), "https://r.test", async () => true)).toEqual({
      publish: false,
      reason: "already on https://r.test",
    });
  });

  test("a version not on the registry is published", async () => {
    expect(await publishAction(at("0.1.0"), "https://r.test", async () => false)).toEqual({ publish: true });
  });

  test("asks the registry for the workspace's own name and version", async () => {
    const asked: string[] = [];
    await publishAction(at("0.1.0"), "https://r.test", async (name, version, registry) => {
      asked.push(`${name}@${version} ${registry}`);
      return false;
    });
    expect(asked).toEqual(["@mercury-fw/plugin-new@0.1.0 https://r.test"]);
  });
});

describe("publishCommand", () => {
  test("publishes the tarball with npm, which trusted publishing needs", () => {
    expect(publishCommand("/tmp/core.tgz", { registry: "https://registry.npmjs.org", dryRun: false })).toEqual([
      "npm",
      "publish",
      "/tmp/core.tgz",
      "--access",
      "public",
      "--registry=https://registry.npmjs.org",
    ]);
  });

  test("a dist-tag and a dry run are passed through", () => {
    expect(publishCommand("/tmp/core.tgz", { registry: "http://localhost:4873", tag: "next", dryRun: true })).toEqual([
      "npm",
      "publish",
      "/tmp/core.tgz",
      "--access",
      "public",
      "--registry=http://localhost:4873",
      "--tag=next",
      "--dry-run",
    ]);
  });
});

// #136: the release commit took in an untracked package.json (a test bed
// app's), which check-pack then refused, stopping the publish.
describe("stageRelease", () => {
  let repo: string;
  /** git in the throwaway repo, with no global or system config. */
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
      stdout: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    return proc.stdout.toString().trim();
  };
  const write = (path: string, content: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "release-stage-"));
    git("init", "-q");
    write("packages/a/package.json", '{"version":"1.0.0"}');
    write("packages/a/CHANGELOG.md", "# a\n");
    write(".changeset/one.md", "---\n---\n");
    write("bun.lock", "v1");
    write("src/code.ts", "1");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("stages what a release changes, never an untracked package.json", () => {
    write("packages/a/package.json", '{"version":"1.1.0"}');
    write("packages/a/CHANGELOG.md", "# a\n## 1.1.0\n");
    write("packages/b/CHANGELOG.md", "# b\n");
    rmSync(join(repo, ".changeset/one.md"));
    write("bun.lock", "v2");
    write("apps/testbed/apps/prova/package.json", '{"name":"prova"}');
    write("src/code.ts", "2");
    stageRelease(repo);
    expect(git("diff", "--cached", "--name-only").split("\n").sort()).toEqual([
      ".changeset/one.md",
      "bun.lock",
      "packages/a/CHANGELOG.md",
      "packages/a/package.json",
      "packages/b/CHANGELOG.md",
    ]);
  });
});

// Guards the publish workflow: a plugin's skill-training folder imports from
// outside the package (the trainer's contract), and building its types with the
// package's rootDir failed (TS6059), stopping every release.
describe("the type build", () => {
  test("leaves the repo-only folders out, as the pack does", () => {
    const config = typesConfig(true);
    for (const dir of REPO_ONLY_DIRS) expect(config.exclude).toContain(dir);
  });

  test("extends the package's own tsconfig when it has one", () => {
    expect(typesConfig(true).extends).toBe("./tsconfig.json");
    expect(typesConfig(false).extends).toBe("@mercury-fw/typescript-config/base.json");
  });
});
