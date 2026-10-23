/**
 * The release scripts' decisions, tested apart from the registry and git: the
 * order packages are built and published in, what counts as "already
 * published", what a pack may and may not contain, and whether there is
 * anything to release.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderByDependencies, REPO_ONLY_DIRS, root, workspaces, type Workspace } from "./workspaces.ts";
import { typesConfig } from "./build-types.ts";
import { isPublished, publishAction, publishCommand, writeGithubOutput } from "./publish.ts";
import { comparePack, privacyProblem } from "./check-pack.ts";
import { pendingChangesets, stageRelease } from "./release.ts";
import { changelogSection, createReleaseCommand, parseTag, publishedOnNpm, releaseNotes, releasesToCreate } from "./github-releases.ts";

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

// Guards the publish workflow: the docs site came in private but missing from
// check-pack's list of private workspaces, and nothing before publishing ran
// that check, so the first publish after its merge stopped there.
describe("privacyProblem", () => {
  test("a workspace meant to stay private must be private, and a private one must be meant to", () => {
    expect(privacyProblem({ name: "testbed", private: true })).toBeUndefined();
    expect(privacyProblem({ name: "testbed" })).toBe("testbed: must stay private");
    expect(privacyProblem({ name: "@mercury-fw/core" })).toBeUndefined();
    expect(privacyProblem({ name: "@mercury-fw/new-thing", private: true })).toBe("@mercury-fw/new-thing: is private, but it's meant to be published");
  });

  test.each(workspaces().map((w) => [w.pkg.name, w] as const))("%s is as private as check-pack expects", (_name, w) => {
    expect(privacyProblem(w.pkg)).toBeUndefined();
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

  // The tests above can't catch TS6059 itself. This one asks tsc which files the build would take: a source outside the packages (the trainer's, under apps/)
  // is what TS6059 refuses. Other packages' sources are listed only because their dist/ isn't
  // built here; the real build reads their declarations.
  test("plugin-jira's type build takes no file from outside the packages, and would without the exclusion", () => {
    const pkg = join(root, "packages/tools/plugin-jira");
    const outside = (config: ReturnType<typeof typesConfig>) => {
      const file = join(pkg, `tsconfig.types-test-${process.pid}.json`);
      writeFileSync(file, JSON.stringify(config));
      try {
        const listed = Bun.spawnSync([join(root, "node_modules/.bin/tsc"), "-p", file, "--listFilesOnly"], { cwd: pkg }).stdout.toString();
        return listed
          .split("\n")
          .filter((f) => f.endsWith(".ts") && !f.includes("/node_modules/"))
          .filter((f) => !f.startsWith(`${join(root, "packages")}/`));
      } finally {
        rmSync(file);
      }
    };
    expect(outside(typesConfig(true))).toEqual([]);
    const withoutExclusion = { ...typesConfig(true), exclude: typesConfig(true).exclude.filter((d) => !REPO_ONLY_DIRS.includes(d)) };
    expect(outside(withoutExclusion)).toContain(join(root, "apps/skill-trainer/src/contract.ts"));
  }, 30_000);
});

describe("changelogSection", () => {
  const md = [
    "# @mercury-fw/core",
    "",
    "## 0.59.1",
    "",
    "### Patch Changes",
    "",
    "- 44f2540: A fix.",
    "",
    "## 0.59.0",
    "",
    "### Minor Changes",
    "",
    "- 7c9a038: A feature.",
    "",
  ].join("\n");

  test("the section of that version, without its heading, up to the next version", () => {
    expect(changelogSection(md, "0.59.1")).toBe("### Patch Changes\n\n- 44f2540: A fix.");
    expect(changelogSection(md, "0.59.0")).toBe("### Minor Changes\n\n- 7c9a038: A feature.");
  });

  test("null when the version has no section; 0.5.9 never matches 0.59.0", () => {
    expect(changelogSection(md, "0.58.0")).toBeNull();
    expect(changelogSection(md, "0.5.9")).toBeNull();
    expect(changelogSection("## 0.59.0\n\n- x", "0.5.9")).toBeNull();
  });
});

describe("parseTag", () => {
  test("vX.Y.Z is the framework, <name>@<version> a package, scoped or not, anything else null", () => {
    expect(parseTag("v0.59.1")).toEqual({ kind: "framework", name: null, version: "0.59.1" });
    expect(parseTag("@mercury-fw/plugin-jira@0.8.0")).toEqual({ kind: "package", name: "@mercury-fw/plugin-jira", version: "0.8.0" });
    expect(parseTag("create-mercury-agent@0.52.0")).toEqual({ kind: "package", name: "create-mercury-agent", version: "0.52.0" });
    expect(parseTag("nightly")).toBeNull();
  });
});

describe("releaseNotes", () => {
  const changelogs: Record<string, string> = {
    "@mercury-fw/core": [
      "## 0.59.0",
      "",
      "### Minor Changes",
      "",
      "- 7c9a038: Channels get the framework's version.",
      "",
      "  - `ctx.frameworkVersion`, `major.minor.patch`.",
      "",
      "### Patch Changes",
      "",
      "- Updated dependencies [7c9a038]",
      "  - @mercury-fw/channel-types@0.59.0",
      "  - @mercury-fw/utils@0.59.0",
      "- 1a2b3c4: The core's own fix.",
      "  - @mercury-fw/plugin-types@0.59.0",
      "  - @mercury-fw/cli-engine@0.59.0",
      "",
      "## 0.58.0",
      "",
      "### Patch Changes",
      "",
      "- @mercury-fw/plugin-types@0.58.0",
    ].join("\n"),
    "@mercury-fw/channel-types": ["## 0.59.0", "", "### Minor Changes", "", "- 7c9a038: Channels get the framework's version.", "", "  - `ctx.frameworkVersion`, `major.minor.patch`."].join("\n"),
    "@mercury-fw/cli": ["## 0.59.0", "", "### Patch Changes", "", "- 9f8e7d6: A CLI fix.", "- @mercury-fw/core@0.59.0"].join("\n"),
    "@mercury-fw/plugin-jira": ["## 0.8.0", "", "### Minor Changes", "", "- eac72fa: Jira describes itself.", "", "### Patch Changes", "", "- Updated dependencies [eac72fa]", "  - @mercury-fw/plugin-types@0.55.0"].join("\n"),
    "@mercury-fw/plugin-bitbucket": ["## 0.3.1", "", "### Patch Changes", "", "- Updated dependencies [eac72fa]", "  - @mercury-fw/plugin-types@0.55.0"].join("\n"),
  };
  const ctx = {
    fixed: ["@mercury-fw/core", "@mercury-fw/channel-types", "@mercury-fw/utils", "@mercury-fw/cli"],
    changelog: (name: string) => changelogs[name] ?? null,
  };

  test("a framework release merges the fixed group's sections: once per entry, dependency bumps dropped, grouped by kind", () => {
    expect(releaseNotes("v0.59.0", ctx)).toBe(
      [
        "### Minor Changes",
        "",
        "- 7c9a038: Channels get the framework's version.",
        "",
        "  - `ctx.frameworkVersion`, `major.minor.patch`.",
        "",
        "### Patch Changes",
        "",
        "- 1a2b3c4: The core's own fix.",
        "- 9f8e7d6: A CLI fix.",
      ].join("\n"),
    );
  });

  // Guards the backfill: one changeset is a minor for some packages of the
  // fixed group and a patch for others, and v0.56.0 listed it under both.
  test("an entry that's a minor in one package and a patch in another appears once, under the higher kind", () => {
    const entry = "- 1126106: Every turn carries its time.";
    const twoKinds = {
      fixed: ["a", "b"],
      changelog: (name: string) =>
        name === "a" ? `## 0.56.0\n\n### Minor Changes\n\n${entry}` : `## 0.56.0\n\n### Patch Changes\n\n${entry}\n- 2b3c4d5: Only b's.`,
    };
    expect(releaseNotes("v0.56.0", twoKinds)).toBe(`### Minor Changes\n\n${entry}\n\n### Patch Changes\n\n- 2b3c4d5: Only b's.`);
  });

  test("a package release is its own section, cleaned the same way", () => {
    expect(releaseNotes("@mercury-fw/plugin-jira@0.8.0", ctx)).toBe("### Minor Changes\n\n- eac72fa: Jira describes itself.");
  });

  test("nothing left once the bumps are gone, or no section at all: says so", () => {
    expect(releaseNotes("v0.58.0", ctx)).toBe("Dependency updates only.");
    expect(releaseNotes("@mercury-fw/plugin-bitbucket@0.3.1", ctx)).toBe("Dependency updates only.");
    expect(releaseNotes("v0.1.0", ctx)).toBe("Dependency updates only.");
  });
});

describe("releasesToCreate", () => {
  test("the tags without a Release, of a known shape: the framework's oldest first, then the packages'", () => {
    const tags = ["v0.59.1", "@mercury-fw/plugin-jira@0.10.0", "v0.9.0", "nightly", "v0.10.0", "@mercury-fw/plugin-jira@0.8.0", "v0.58.0"];
    expect(releasesToCreate(tags, new Set(["v0.58.0"]))).toEqual([
      "v0.9.0",
      "v0.10.0",
      "v0.59.1",
      "@mercury-fw/plugin-jira@0.8.0",
      "@mercury-fw/plugin-jira@0.10.0",
    ]);
  });

  test("nothing when every tag has one", () => {
    expect(releasesToCreate(["v0.59.1"], new Set(["v0.59.1"]))).toEqual([]);
  });
});

describe("createReleaseCommand", () => {
  test("the framework's newest tag is Latest, any other framework tag and every package never", () => {
    const all = ["v0.58.0", "v0.59.1", "v0.10.0", "@mercury-fw/plugin-jira@9.0.0"];
    expect(createReleaseCommand("v0.59.1", all)).toEqual([
      "gh", "release", "create", "v0.59.1", "--title", "Mercury Framework 0.59.1", "--notes-file", "-", "--verify-tag", "--latest",
    ]);
    expect(createReleaseCommand("v0.58.0", all)).toContain("--latest=false");
    expect(createReleaseCommand("@mercury-fw/plugin-jira@9.0.0", all)).toEqual([
      "gh", "release", "create", "@mercury-fw/plugin-jira@9.0.0", "--title", "@mercury-fw/plugin-jira 9.0.0", "--notes-file", "-", "--verify-tag", "--latest=false",
    ]);
  });
});

describe("publishedOnNpm", () => {
  test("a framework tag is checked as the core's version, a package tag as itself", async () => {
    const asked: string[] = [];
    const published = async (name: string, version: string) => {
      asked.push(`${name}@${version}`);
      return name !== "@mercury-fw/plugin-jira";
    };
    expect(await publishedOnNpm("v0.59.1", "https://r", published)).toBe(true);
    expect(await publishedOnNpm("@mercury-fw/plugin-jira@0.8.0", "https://r", published)).toBe(false);
    expect(asked).toEqual(["@mercury-fw/core@0.59.1", "@mercury-fw/plugin-jira@0.8.0"]);
  });
});

describe("writeGithubOutput", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gh-output-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("appends published=<n> to the file GitHub Actions names, after what's already there", () => {
    const file = join(dir, "output");
    writeFileSync(file, "earlier=1\n");
    writeGithubOutput(file, 3);
    expect(readFileSync(file, "utf-8")).toBe("earlier=1\npublished=3\n");
  });

  test("outside GitHub Actions (no file named) it writes nothing", () => {
    expect(() => writeGithubOutput(undefined, 3)).not.toThrow();
  });
});
