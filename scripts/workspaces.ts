/**
 * The repo's workspaces as the release scripts see them: every workspace with
 * its manifest, and the public ones in dependency order (each after the
 * workspaces it depends on), which is the order types are built and packages
 * published in.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
export type Workspace = { dir: string; pkg: Manifest };

/** The repo root. */
export const root = join(import.meta.dir, "..");

/** Folders a workspace keeps in the repo but never publishes (a plugin's
 * skill-training data, read by the skill trainer): out of the pack and out of
 * the type build, since they may import from outside the package. */
export const REPO_ONLY_DIRS = ["skill-training"];

/** Every workspace (not the monorepo root), from the git-tracked manifests. */
export function workspaces(): Workspace[] {
  const proc = Bun.spawnSync(["git", "ls-files", "--", "*package.json"], { cwd: root, stdout: "pipe" });
  return proc.stdout
    .toString()
    .split("\n")
    .filter((f) => f && f !== "package.json")
    .map((f) => ({ dir: join(root, dirname(f)), pkg: JSON.parse(readFileSync(join(root, f), "utf-8")) as Manifest }));
}

/** The public workspaces, each after the workspaces it depends on. */
export function publicWorkspacesInOrder(): Workspace[] {
  return orderByDependencies(workspaces().filter((w) => !w.pkg.private));
}

/** `all`, each after the workspaces of `all` it depends on (dependencies and
 * peers; anything outside `all` is ignored), otherwise in the given order. */
export function orderByDependencies(all: Workspace[]): Workspace[] {
  const byName = new Map(all.map((w) => [w.pkg.name, w]));
  const ordered: Workspace[] = [];
  const seen = new Set<string>();
  const visit = (w: Workspace) => {
    if (seen.has(w.pkg.name)) return;
    seen.add(w.pkg.name);
    for (const dep of Object.keys({ ...w.pkg.dependencies, ...w.pkg.peerDependencies })) {
      const target = byName.get(dep);
      if (target) visit(target);
    }
    ordered.push(w);
  };
  all.forEach(visit);
  return ordered;
}

/** Runs `cmd` in `cwd`, inheriting output; throws when it fails. */
export function run(cmd: string[], cwd: string = root): void {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
  }
}
