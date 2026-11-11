import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTraceSecret, traceSecretPath } from "./trace-secret.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-trace-secret-"));
  dirs.push(dir);
  return dir;
}

describe("traceSecretPath", () => {
  test("lives in the data folder, out of the model's reach", () => {
    expect(traceSecretPath("/data")).toBe("/data/trace-secret");
  });
});

describe("loadTraceSecret", () => {
  test("makes a random secret the first time, readable only by its owner", async () => {
    const vault = await tempVault();
    const secret = await loadTraceSecret(vault);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(traceSecretPath(vault), "utf8")).trim()).toBe(secret);
    expect((await stat(traceSecretPath(vault))).mode & 0o777).toBe(0o600);
  });

  test("gives back the same secret on the next start, so pseudonyms stay stable across restarts", async () => {
    const vault = await tempVault();
    expect(await loadTraceSecret(vault)).toBe(await loadTraceSecret(vault));
  });

  test("two instances get different secrets", async () => {
    expect(await loadTraceSecret(await tempVault())).not.toBe(await loadTraceSecret(await tempVault()));
  });

  test("a file that isn't a secret is refused and left as it is, never written over", async () => {
    const vault = await tempVault();
    const path = traceSecretPath(vault);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a secret\n");
    await expect(loadTraceSecret(vault)).rejects.toThrow(/trace-secret/);
    expect(await readFile(path, "utf8")).toBe("not a secret\n");
  });
});
