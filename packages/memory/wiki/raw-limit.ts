/**
 * How much of a `raw/` entry the nightly triage takes: a Markdown file (the
 * only kind it lists) of at most `RAW_MAX_BYTES`, so the model reads it whole
 * in one pass. A larger one is left in `raw/` and logged, never triaged in
 * part; `mfw vault write-raw` refuses one up front.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** The largest `raw/` entry the triage takes: 64 KiB, about 16k tokens. */
export const RAW_MAX_BYTES = 64 * 1024;

/** Whether `content` is over the limit, counted in UTF-8 bytes. */
export function rawEntryOverLimit(content: string): boolean {
  return Buffer.byteLength(content, "utf-8") > RAW_MAX_BYTES;
}

/** The entries of `entries` (vault-relative, `raw/…`) within the limit; each one left out is logged with why. */
export async function triageableRawEntries(vaultPath: string, entries: string[], log: (msg: string) => void): Promise<string[]> {
  const kept: string[] = [];
  for (const entry of entries) {
    try {
      const { size } = await stat(resolve(vaultPath, entry));
      if (size > RAW_MAX_BYTES) {
        log(`${entry} is over the raw/ limit (${size} bytes, the limit is ${RAW_MAX_BYTES}): left in raw/, not triaged`);
        continue;
      }
      kept.push(entry);
    } catch (err) {
      log(`${entry} can't be read: ${String(err)}`);
    }
  }
  return kept;
}
