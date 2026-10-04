/**
 * `create-mercury-agent` is `mfw create` under the name `bun create mercury-agent`
 * looks for: for the same arguments it writes the same app, file for file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const CREATE = new URL("./index.ts", import.meta.url).pathname;
const MFW = new URL("../cli/src/bin.ts", import.meta.url).pathname;

/** A fake registry: `latest` of any package is 0.2.0. */
let registry: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  registry = Bun.serve({ port: 0, fetch: () => Response.json({ version: "0.2.0" }) });
});
afterAll(() => {
  registry.stop(true);
});

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "create-mercury-agent-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Runs `cmd` against the fake registry, returning its exit code and output. */
async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    env: { ...process.env, MFW_REGISTRY: registry.url.origin },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Every file under `dir`, as `relative path → content`. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "utf-8");
    }
  };
  walk(dir);
  return out;
}

describe("create-mercury-agent", () => {
  test("writes the same app as `mfw create` for the same arguments", async () => {
    // The written files only: install and git are tested in apps/cli, and here
    // they would differ between the two folders (#125).
    const flags = ["--name", "demo", "--channels", "http", "--auth", "static", "--plugins", "jira", "--no-install", "--no-git", "--yes"];
    const viaCreate = await run(["bun", CREATE, join(base, "a"), ...flags]);
    const viaMfw = await run(["bun", MFW, "create", join(base, "b"), ...flags]);
    expect(viaCreate.code).toBe(0);
    expect(viaMfw.code).toBe(0);
    const a = tree(join(base, "a"));
    expect(Object.keys(a).length).toBeGreaterThan(10);
    expect(a).toEqual(tree(join(base, "b")));
  });

  test("--help shows the create usage", async () => {
    const result = await run(["bun", CREATE, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: mfw create [options] <folder>");
  });

  test("an error exits 1, like mfw create", async () => {
    const result = await run(["bun", CREATE]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("folder");
  });
});
