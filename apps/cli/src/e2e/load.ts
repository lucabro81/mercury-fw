/**
 * Which e2e test files `mfw e2e` runs, and loading one: Bun imports the
 * TypeScript file as it is, and its default export is checked to look like
 * a test before anything starts.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { E2eTest } from "./define.ts";

/** The files to run: `named` resolved from `cwd`, or, when none is named,
 * the app's `e2e/*.e2e.ts` in name order. */
export function findTests(named: string[], { appDir, cwd }: { appDir: string; cwd: string }): string[] {
  if (named.length > 0) return named.map((f) => resolve(cwd, f));
  const folder = join(appDir, "e2e");
  const found = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".e2e.ts")).sort() : [];
  if (found.length === 0) throw new Error(`No tests: none named, and no *.e2e.ts in ${folder}`);
  return found.map((f) => join(folder, f));
}

/** The test `file` exports as default; throws naming the file when it isn't one. */
export async function loadTest(file: string): Promise<E2eTest> {
  const loaded = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default as Partial<E2eTest> | undefined;
  if (loaded === undefined || loaded === null || !Array.isArray(loaded.cases)) {
    throw new Error(`${file} doesn't export a test as default (export default e2e({ … }))`);
  }
  for (const [i, c] of loaded.cases.entries()) {
    const which = `${file}: case ${i + 1} ("${c?.name ?? "?"}")`;
    if (typeof c?.name !== "string") throw new Error(`${which} has no name`);
    const nonEmpty = (list: unknown) => Array.isArray(list) && list.length > 0;
    if (c.turns !== undefined && c.lanes !== undefined) throw new Error(`${which} has both turns and lanes`);
    if (c.lanes !== undefined) {
      if (!nonEmpty(c.lanes)) throw new Error(`${which} has no turns`);
      for (const [j, lane] of c.lanes.entries()) {
        if (!nonEmpty(lane?.turns)) throw new Error(`${which} lane ${j + 1} has no turns`);
      }
    } else if (!nonEmpty(c.turns)) throw new Error(`${which} has no turns`);
    if (typeof c.check !== "function") throw new Error(`${which} has no check`);
    const whole = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1;
    if (c.repeat !== undefined && !whole(c.repeat)) throw new Error(`${which} repeat takes a positive whole number`);
    if (c.minPasses !== undefined && !whole(c.minPasses)) throw new Error(`${which} minPasses takes a positive whole number`);
    if (c.minPasses !== undefined && c.minPasses > (c.repeat ?? 1)) {
      throw new Error(`${which} minPasses (${c.minPasses}) is more than repeat (${c.repeat ?? 1})`);
    }
  }
  return loaded as E2eTest;
}
