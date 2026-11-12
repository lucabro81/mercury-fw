/**
 * Publishes every public workspace whose current version isn't on the
 * registry yet, dependencies before their dependents. A workspace at 0.0.0
 * (a new package merged before its first release) is skipped. Run from the
 * repo root after `bun run release`:
 *
 *   bun scripts/publish.ts [--registry <url>] [--tag <dist-tag>] [--dry-run]
 *
 * First it emits the type declarations (`scripts/build-types.ts`) and checks
 * every pack with them (`scripts/check-pack.ts --types`); a problem stops
 * everything before anything is published. Then each package is packed with
 * `bun pm pack`, which rewrites `workspace:*` into real versions, and the
 * tarball is published with `npm publish`, the only client npm's trusted
 * publishing works with (in CI the registry trusts the workflow through OIDC,
 * no token). Never `changeset publish` or `npm publish` on the folder: both
 * leave `workspace:*` in the published manifests. Locally, authentication is
 * the registry's usual one (an `.npmrc` token). npm takes a while to show a
 * version it has just taken: a rerun in that window publishes it again, and
 * npm's refusal of a version it already has counts as published, so a rerun
 * goes on at once. Without `--tag`, versions go
 * to `latest`, which is where the CLI looks plugins up. In GitHub Actions it
 * also writes how many packages it published (`published=<n>`) to
 * `$GITHUB_OUTPUT`: `publish.yml` deploys the docs site only when it isn't 0.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { publicWorkspacesInOrder, run } from "./workspaces.ts";

/** Whether `name@version` is on `registry`: a 404 means it isn't, a success
 * that it is. Anything else (an auth error, rate limiting, an outage) throws,
 * so a registry problem never passes for a version waiting to be published. */
export async function isPublished(
  name: string,
  version: string,
  registry: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchFn(`${registry}/${name.replace("/", "%2F")}/${version}`);
  } catch {
    throw new Error(`Can't reach ${registry} to check ${name}@${version}`);
  }
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new Error(`${registry} answered ${res.status} checking ${name}@${version}: stopping`);
}

/**
 * Whether `stderr`, from a failed `npm publish`, is npm refusing a version it
 * already has: one it took but doesn't show yet (`E409`, "previously staged
 * version"), or one it shows (`E403`, "previously published versions"). Any
 * other failure (a forbidden publish, the network) isn't.
 */
export function alreadyOnRegistry(stderr: string): boolean {
  return (
    (/\bE409\b/.test(stderr) && /previously staged version/i.test(stderr)) ||
    (/\bE403\b/.test(stderr) && /cannot publish over the previously published version/i.test(stderr))
  );
}

/** Runs `npm publish` (`cmd`) in `cwd`, its output passed through: `"already"` when npm refuses the version as one it has (`alreadyOnRegistry`); throws on any other failure. */
export function npmPublish(cmd: string[], cwd: string): "published" | "already" {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "pipe" });
  const stderr = proc.stderr.toString();
  process.stderr.write(stderr);
  if (proc.exitCode === 0) return "published";
  if (alreadyOnRegistry(stderr)) return "already";
  throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
}

/** The version a brand-new package carries until its first release bumps it. */
const UNRELEASED = "0.0.0";

/**
 * What to do with one workspace: skip it while it's unreleased (a new package
 * merged before its first release: its first version is published by hand,
 * since it can't be trusted before it exists), skip it when the registry
 * already has its version, publish it otherwise. `published` is the registry
 * check (`isPublished`), asked only when the version could be published.
 */
export async function publishAction(
  pkg: { name: string; version: string },
  registry: string,
  published: (name: string, version: string, registry: string) => Promise<boolean> = isPublished,
): Promise<{ publish: true } | { publish: false; reason: string }> {
  if (pkg.version === UNRELEASED) return { publish: false, reason: "not released yet" };
  if (await published(pkg.name, pkg.version, registry)) return { publish: false, reason: `already on ${registry}` };
  return { publish: true };
}

/** The `npm publish` argv for one packed tarball. */
export function publishCommand(
  tarball: string,
  { registry, tag, dryRun }: { registry: string; tag?: string; dryRun: boolean },
): string[] {
  const cmd = ["npm", "publish", tarball, "--access", "public", `--registry=${registry}`];
  if (tag) cmd.push(`--tag=${tag}`);
  if (dryRun) cmd.push("--dry-run");
  return cmd;
}

/** Tells the workflow how many packages were published (`published=<n>`), by
 * appending to the file GitHub Actions names in `GITHUB_OUTPUT`; nothing
 * outside GitHub Actions. `publish.yml` deploys the docs site only when it
 * isn't 0. */
export function writeGithubOutput(file: string | undefined, published: number): void {
  if (file) appendFileSync(file, `published=${published}\n`);
}

/** What `publishAll` needs from the world: the decision for a package
 * (`publishAction`), how to publish one, where to say what it does. */
export type PublishAllDeps = {
  decide: (pkg: { name: string; version: string }) => Promise<{ publish: true } | { publish: false; reason: string }>;
  /** `"already"` when npm refused the version as one it already has. */
  publishOne: (workspace: { dir: string; pkg: { name: string; version: string } }) => "published" | "already";
  log: (line: string) => void;
};

/** Publishes each of `workspaces`, in order, that `decide` lets through, and
 * returns how many it published: skipped ones don't count, ones npm refused
 * as already published do (a rerun that meets only those still lets the site
 * of the release deploy). */
export async function publishAll(
  workspaces: Array<{ dir: string; pkg: { name: string; version: string } }>,
  deps: PublishAllDeps,
): Promise<number> {
  let published = 0;
  for (const w of workspaces) {
    const action = await deps.decide(w.pkg);
    if (!action.publish) {
      deps.log(`skip ${w.pkg.name}@${w.pkg.version}: ${action.reason}`);
      continue;
    }
    deps.log(`publish ${w.pkg.name}@${w.pkg.version}`);
    if (deps.publishOne(w) === "already") deps.log(`already on the registry (npm hasn't shown it yet): ${w.pkg.name}@${w.pkg.version}`);
    published++;
  }
  return published;
}

/** Packs the workspace in `dir` into `destination` and returns the tarball's path. */
export function pack(dir: string, destination: string): string {
  const proc = Bun.spawnSync(["bun", "pm", "pack", "--destination", destination, "--quiet"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error(`bun pm pack failed in ${dir}`);
  return proc.stdout.toString().trim();
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      registry: { type: "string", default: "https://registry.npmjs.org" },
      tag: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const registry = (values.registry as string).replace(/\/+$/, "");
  const tarballs = mkdtempSync(join(tmpdir(), "mercury-publish-"));
  try {
    run(["bun", "scripts/build-types.ts"]);
    run(["bun", "scripts/check-pack.ts", "--types"]);
    const published = await publishAll(publicWorkspacesInOrder(), {
      decide: (pkg) => publishAction(pkg, registry),
      // From the tarballs' folder, outside the repo: npm would otherwise read
      // the root manifest's devEngines (Bun) and refuse to run.
      publishOne: ({ dir }) =>
        npmPublish(publishCommand(pack(dir, tarballs), { registry, tag: values.tag, dryRun: values["dry-run"] as boolean }), tarballs),
      log: (line) => console.log(line),
    });
    if (!values["dry-run"]) writeGithubOutput(process.env.GITHUB_OUTPUT, published);
  } catch (err) {
    // What's published stays published; rerunning skips it and carries on.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    rmSync(tarballs, { recursive: true, force: true });
  }
}
