/**
 * Emits each public workspace's type declarations into its `dist/`, in
 * dependency order, for publishing. The packages ship their TypeScript source
 * (Bun runs it as is); the declarations are what an app's `tsc` reads instead,
 * so it never type-checks the framework's internals against whatever versions
 * the app happened to resolve. `dist/` is not committed.
 *
 * Each package is built with a throwaway tsconfig that extends its own, leaves
 * the tests, the postinstall scripts and the repo-only folders out, and drops
 * the `mercury-fw-source` condition: its `@mercury-fw/*` imports then resolve
 * to the declarations just emitted for those packages, not to their source.
 *
 * Run from the repo root: `bun scripts/build-types.ts`.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicWorkspacesInOrder, REPO_ONLY_DIRS, root, run } from "./workspaces.ts";

const tsc = join(root, "node_modules/.bin/tsc");
const BUILD_CONFIG = "tsconfig.types.json";

/** The throwaway tsconfig a package's declarations are built with. */
export function typesConfig(hasOwnTsconfig: boolean) {
  return {
    extends: hasOwnTsconfig ? "./tsconfig.json" : "@mercury-fw/typescript-config/base.json",
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: "dist",
      rootDir: ".",
      customConditions: [],
    },
    include: ["**/*.ts"],
    exclude: ["**/*.test.ts", "dist", "node_modules", "scripts", ...REPO_ONLY_DIRS],
  };
}

if (import.meta.main) {
  for (const { dir, pkg } of publicWorkspacesInOrder()) {
    if (!pkg.exports) {
      continue;
    }
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    const config = join(dir, BUILD_CONFIG);
    writeFileSync(config, JSON.stringify(typesConfig(existsSync(join(dir, "tsconfig.json")))));
    try {
      console.log(`types ${pkg.name}`);
      run([tsc, "-p", BUILD_CONFIG], dir);
    } finally {
      rmSync(config);
    }
    // Hand-written declarations aren't emitted, but the emitted ones can refer to
    // them (`/// <reference path>`): copy them to the same place under dist/.
    for (const file of new Bun.Glob("**/*.d.ts").scanSync({ cwd: dir })) {
      if (file.startsWith("dist/") || file.startsWith("node_modules/")) continue;
      mkdirSync(dirname(join(dir, "dist", file)), { recursive: true });
      copyFileSync(join(dir, file), join(dir, "dist", file));
    }
  }
}
