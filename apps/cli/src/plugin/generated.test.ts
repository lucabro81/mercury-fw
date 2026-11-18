/**
 * What `mfw plugin create` writes works as written: every kind's package,
 * generated into a folder inside this workspace (so it resolves the kit, the
 * engine, `ai` and `zod` as an app's workspace does), typechecks against the
 * contracts of this repo, and its own tests pass. A contract change that
 * breaks a template fails here, not in someone's new plugin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLUGIN_KINDS } from "./kinds.ts";
import { renderPlugin } from "./render.ts";

/** Where the packages are written: inside the CLI's workspace, ignored by git, removed afterwards. */
const ROOT = join(import.meta.dir, "../../.scaffold-check");

/** Runs `argv` in `cwd`; its exit code and everything it printed. */
async function run(argv: string[], cwd: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "0" } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: stdout + stderr };
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const kind of PLUGIN_KINDS) {
    const files = renderPlugin({
      kind,
      name: `demo-${kind}`,
      target: { type: "app", appName: "scaffold-check" },
      versions: { framework: "0.0.0", ai: "^7.0.0", zod: "^4.0.0" },
      ...(kind === "cli" ? { cli: { binary: "demo", repo: "acme/demo-cli", version: "1.0.0" } } : {}),
    });
    for (const [path, content] of files) {
      const file = join(ROOT, kind, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  writeFileSync(join(ROOT, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.json", include: ["**/*.ts"], exclude: [] }));
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("the generated packages", () => {
  test(
    "typecheck",
    async () => {
      const { code, output } = await run([join(import.meta.dir, "../../node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"], ROOT);
      expect({ code, output }).toEqual({ code: 0, output: "" });
    },
    120_000,
  );

  test(
    "pass their own tests",
    async () => {
      const { code, output } = await run(["bun", "test"], ROOT);
      expect({ code, failed: output.match(/^\(fail\).*$/gm) ?? [] }).toEqual({ code: 0, failed: [] });
      expect(output).toMatch(/ 0 fail/);
      // Every kind's tests ran: none of them is skipped by a file that didn't load.
      expect(Number(/ (\d+) pass/.exec(output)?.[1])).toBeGreaterThanOrEqual(60);
    },
    120_000,
  );
});
