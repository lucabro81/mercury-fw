import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAW_MAX_BYTES, rawEntryOverLimit, triageableRawEntries } from "./raw-limit.ts";
import { initVault } from "./vault-init.ts";
import { writeRawEntry } from "./wiki-note.ts";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-raw-limit-test-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("the raw/ limit", () => {
  it("is 64 KiB", () => {
    expect(RAW_MAX_BYTES).toBe(64 * 1024);
  });

  it("rawEntryOverLimit counts bytes, not characters", () => {
    expect(rawEntryOverLimit("a".repeat(RAW_MAX_BYTES))).toBe(false);
    expect(rawEntryOverLimit("a".repeat(RAW_MAX_BYTES + 1))).toBe(true);
    // "è" is two bytes in UTF-8: half the limit in characters is the whole limit in bytes.
    expect(rawEntryOverLimit("è".repeat(RAW_MAX_BYTES / 2))).toBe(false);
    expect(rawEntryOverLimit("è".repeat(RAW_MAX_BYTES / 2 + 1))).toBe(true);
  });

  it("triageableRawEntries keeps the entries within the limit and logs each one left out, by path and size", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "small.md", "short");
    await writeRawEntry(vaultPath, "big.md", "x".repeat(RAW_MAX_BYTES + 10));
    const logs: string[] = [];

    const kept = await triageableRawEntries(vaultPath, ["raw/big.md", "raw/small.md"], (m) => logs.push(m));

    expect(kept).toEqual(["raw/small.md"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^raw\/big\.md is over the raw\/ limit \(\d+ bytes, the limit is 65536\): left in raw\/, not triaged$/);
  });

  it("triageableRawEntries leaves out an entry it can't read, logging why, and keeps the rest", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "small.md", "short");
    const logs: string[] = [];

    const kept = await triageableRawEntries(vaultPath, ["raw/gone.md", "raw/small.md"], (m) => logs.push(m));

    expect(kept).toEqual(["raw/small.md"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith("raw/gone.md can't be read: ");
  });
});
