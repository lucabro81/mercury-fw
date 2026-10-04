/**
 * The vault CLI (`mfw vault`) run as the script it is, on a temporary vault.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "vault-cli.ts");
let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "mercury-vault-cli-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Runs the CLI with `args` on the temporary vault, `stdin` as its input. */
async function run(args: string[], stdin = "") {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, WIKI_VAULT_PATH: vault },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("vault-cli read", () => {
  test("a note that exists is printed", async () => {
    expect((await run(["write-curated", "curated/x.md"], "Hello.\n")).code).toBe(0);
    const r = await run(["read", "curated/x.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Hello.");
  });

  // Regression: reading a missing note died with Bun's ENOENT stack trace.
  test("a missing note is one clear line, exit 1", async () => {
    expect(await run(["read", "curated/nope.md"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "no note at curated/nope.md (mfw vault list shows them)\n",
    });
  });
});

// Regression: read joined the path onto the vault unchecked, so "../" printed
// files outside it (the container's own, the operator's env file included).
describe("vault-cli read outside the vault", () => {
  test("a path that leaves the vault is refused, exit 1, nothing printed", async () => {
    const outside = join(vault, "..", `${vault.split("/").pop()}-outside.md`);
    await Bun.write(outside, "secret");
    try {
      for (const path of [`../${outside.split("/").pop()}`, outside, "curated/../../x.md"]) {
        expect(await run(["read", path])).toEqual({ code: 1, stdout: "", stderr: `not a path in the vault: ${path}\n` });
      }
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("vault-cli grep", () => {
  // #138: wiki grep ignores case, here as in the model's tool.
  test("ignores case", async () => {
    expect((await run(["write-curated", "curated/projects/names.md"], "Monorepo: MON\n")).code).toBe(0);
    const r = await run(["grep", "monorepo"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("curated/projects/names.md:");
    expect(r.stdout).toContain("Monorepo: MON");
  });
});
