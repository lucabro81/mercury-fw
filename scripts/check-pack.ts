/**
 * Checks what each workspace would publish, before anything is published.
 *
 * - Every workspace is public except the ones that must never reach a
 *   registry (the test bed, the skill trainer, the docs site, the shared
 *   tsconfig; the monorepo root isn't a workspace). `bun run test` checks every
 *   workspace against that list too, and CI runs this check on every pull
 *   request (`.github/workflows/ci.yml`), so a mismatch shows up before a publish.
 * - A public workspace's pack (`bun pm pack --dry-run`) contains exactly its
 *   git-tracked files minus what only matters in this repo (tests, fixtures,
 *   tsconfig, Turbo logs, downloaded binaries), plus its package.json: nothing
 *   missing that the package needs at run time, nothing leaking into it.
 *
 * - With `--types` (what publishing runs, after `scripts/build-types.ts`), a
 *   package that has `exports` also ships a declaration for every source file
 *   under `dist/`; without it, `dist/` is left out of the comparison.
 *
 * Run from the repo root: `bun scripts/check-pack.ts [--types]`. Exits 1
 * listing every problem found.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ONLY_DIRS } from "./workspaces.ts";

/** Workspaces that stay private: never published. A new private workspace goes
 * here too, or the publish stops on it: the list guards both ways. */
const PRIVATE = new Set(["testbed", "skill-trainer", "@mercury-fw/typescript-config", "@mercury-fw/docs"]);

/** What's wrong with `pkg`'s `private` flag: a workspace on the list that isn't
 * private would be published, a private one not on it would never be. */
export function privacyProblem(pkg: { name: string; private?: boolean }): string | undefined {
  if (PRIVATE.has(pkg.name)) return pkg.private ? undefined : `${pkg.name}: must stay private`;
  return pkg.private ? `${pkg.name}: is private, but it's meant to be published` : undefined;
}

/** Tracked files that belong to the repo, not to a published package. */
const REPO_ONLY = [
  /\.test\.ts$/,
  /(^|\/)__fixtures__\//,
  /(^|\/)tsconfig\.json$/,
  /^bin\//,
  /^\.turbo\//,
  // The HTTP channel's Redocly config, read by the docs site's build, not needed at run time.
  /^redocly\.yaml$/,
  // The repo-only folders (a plugin's skill-training data), shared with the type build.
  ...REPO_ONLY_DIRS.map((dir) => new RegExp(`^${dir}/`)),
];

/** Runs `cmd` in `cwd`, returning its stdout; throws with stderr on failure. */
function run(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

/** The files `bun pm pack --dry-run` lists for the package in `dir`. */
function packedFiles(dir: string): Set<string> {
  const out = run(["bun", "pm", "pack", "--dry-run"], dir);
  const files = out
    .split("\n")
    .map((line) => /^packed\s+\S+\s+(.+)$/.exec(line.trim())?.[1])
    .filter((f): f is string => f !== undefined);
  return new Set(files);
}

/** The git-tracked files under `dir`, relative to it, minus repo-only ones. */
function expectedFiles(root: string, dir: string): Set<string> {
  const rel = dir.slice(root.length + 1);
  const tracked = run(["git", "ls-files", "--", rel], root)
    .split("\n")
    .filter(Boolean)
    .map((f) => f.slice(rel.length + 1));
  return new Set(["package.json", ...tracked.filter((f) => !REPO_ONLY.some((re) => re.test(f)))]);
}

/** The declarations `build-types.ts` emits for the source files in `expected`. */
function declarationsFor(expected: Set<string>): string[] {
  return [...expected]
    .filter((f) => f.endsWith(".ts") && !f.startsWith("scripts/"))
    .map((f) => `dist/${f.endsWith(".d.ts") ? f : f.replace(/\.ts$/, ".d.ts")}`);
}

/** Every difference between what package `name` should contain and what its
 * pack contains: files missing from it first, then files that leaked in. */
export function comparePack(name: string, expected: Set<string>, packed: Set<string>): string[] {
  const problems: string[] = [];
  for (const f of expected) if (!packed.has(f)) problems.push(`${name}: missing from the pack: ${f}`);
  for (const f of packed) if (!expected.has(f)) problems.push(`${name}: shouldn't be in the pack: ${f}`);
  return problems;
}

if (import.meta.main) {
  const root = dirname(import.meta.dir);
  const withTypes = process.argv.includes("--types");
  const manifests = run(["git", "ls-files", "--", "*package.json"], root)
    .split("\n")
    .filter((f) => f && f !== "package.json");

  const problems: string[] = [];
  for (const manifest of manifests) {
    const dir = join(root, dirname(manifest));
    const pkg = JSON.parse(readFileSync(join(root, manifest), "utf-8")) as {
      name: string;
      private?: boolean;
      exports?: unknown;
    };
    const privacy = privacyProblem(pkg);
    if (privacy !== undefined) problems.push(privacy);
    if (privacy !== undefined || pkg.private) continue;
    const packed = packedFiles(dir);
    const expected = expectedFiles(root, dir);
    if (withTypes && pkg.exports) {
      for (const d of declarationsFor(expected)) expected.add(d);
    } else {
      for (const f of [...packed]) if (f.startsWith("dist/")) packed.delete(f);
    }
    problems.push(...comparePack(pkg.name, expected, packed));
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`${manifests.length} workspaces checked, every pack as expected`);
}
