/**
 * What `mfw local-packages` (and `mfw create --local-packages`) writes: the app's `package.json` with `overrides`
 * pointing packages at local tarballs (`bun pm pack`) copied into `.packs/`,
 * which the image copies before `bun install`. Overrides, and not the
 * dependencies themselves, because a packed package names its siblings by
 * version, which the registry has too: only an override sends those
 * transitive dependencies to the tarballs as well. Each tarball is named
 * after its content there: Bun takes a `file:` tarball whose spec didn't
 * change for the one in its lockfile, so a repack at the same version needs
 * another name to be installed.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** The tarballs' folder inside the app, as the Dockerfile copies it. */
export const LOCAL_PACKS_DIR = ".packs";

/** The prefix of every override this command writes, how it tells them from the user's own. */
const LOCAL_OVERRIDE = `file:./${LOCAL_PACKS_DIR}/`;

type Manifest = Record<string, unknown> & { overrides?: Record<string, string> };

/** The user's own overrides in `pkg`: every one this command didn't write. */
function ownOverrides(pkg: Manifest): Record<string, string> {
  return Object.fromEntries(Object.entries(pkg.overrides ?? {}).filter(([, spec]) => !spec.startsWith(LOCAL_OVERRIDE)));
}

/** `pkg` with each of `packs` (a package name and its tarball's file name in
 * `.packs/`) as an override, in place of any left by an earlier run. */
export function withLocalOverrides(pkg: Manifest, packs: Array<{ name: string; file: string }>): Manifest {
  const local = Object.fromEntries(packs.map((p) => [p.name, `${LOCAL_OVERRIDE}${p.file}`]));
  return { ...pkg, overrides: { ...ownOverrides(pkg), ...local } };
}

/** `pkg` without the overrides this command writes; without `overrides` at
 * all when none of the user's own is left. */
export function withoutLocalOverrides(pkg: Manifest): Manifest {
  const { overrides: _, ...rest } = pkg;
  const own = ownOverrides(pkg);
  return Object.keys(own).length > 0 ? { ...rest, overrides: own } : rest;
}

/** A local tarball: its file name in the folder (`source`), its name in the
 * app's `.packs/` (`file`), and the package it holds. */
export type Pack = { source: string; file: string; name: string; version: string };

/** `file`'s name with the first 8 hex digits of `tarball`'s sha256 before `.tgz`. */
function contentName(file: string, tarball: string): string {
  const hash = createHash("sha256").update(readFileSync(tarball)).digest("hex").slice(0, 8);
  return `${file.slice(0, -".tgz".length)}-${hash}.tgz`;
}

/** The package name and version in a `bun pm pack` tarball, read from its
 * `package/package.json`. */
export async function packageOf(tarball: string): Promise<{ name: string; version: string }> {
  const proc = Bun.spawn(["tar", "-xOzf", tarball, "package/package.json"], { stdout: "pipe", stderr: "pipe" });
  const [manifest, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  try {
    if (code !== 0) throw new Error(`tar exited with ${code}`);
    const { name, version } = JSON.parse(manifest) as { name?: unknown; version?: unknown };
    if (typeof name !== "string") throw new Error("no name in its package.json");
    if (typeof version !== "string") throw new Error("no version in its package.json");
    return { name, version };
  } catch (err) {
    throw new Error(`${tarball} isn't a package tarball: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The tarballs in `from`, in file-name order, each with the package it
 * holds and its name after its content, for an app in `appDir`. Throws when
 * `from` doesn't exist, holds no tarball, or is the app's own `.packs/`
 * (which the copy replaces). */
export async function readPacks(from: string, appDir: string): Promise<Pack[]> {
  const source = resolve(from);
  if (source === join(resolve(appDir), LOCAL_PACKS_DIR)) {
    throw new Error(`${source} is the app's own .packs/: give the folder the tarballs were packed into.`);
  }
  if (!existsSync(source)) throw new Error(`${source} doesn't exist.`);
  const files = readdirSync(source).filter((f) => f.endsWith(".tgz")).sort();
  if (files.length === 0) throw new Error(`No .tgz in ${source}: pack the packages there first (bun pm pack).`);
  return Promise.all(
    files.map(async (file) => ({ source: file, file: contentName(file, join(source, file)), ...(await packageOf(join(source, file))) })),
  );
}

/** Copies `packs` from `from` into the app's `.packs/` under their content names, in place of whatever was there. */
export function copyPacks(from: string, appDir: string, packs: Pack[]): void {
  const target = join(appDir, LOCAL_PACKS_DIR);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target);
  for (const { source, file } of packs) cpSync(join(resolve(from), source), join(target, file));
}
