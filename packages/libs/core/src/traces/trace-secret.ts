/**
 * The secret the tracer makes pseudonyms with (`tracer.ts`): generated on the
 * instance's first start and kept in one file in the data folder
 * (`../data/data-dir.ts`), out of every path the model can reach, so the same person
 * gets the same pseudonym across restarts. Nobody configures it; deleting the
 * file makes new pseudonyms from the next start.
 *
 * A file that isn't a secret is refused and never written over: whoever put
 * something else there decides what to do with it.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SECRET_SHAPE = /^[0-9a-f]{64}$/;

/** Where the trace secret lives in the data folder (`../data/data-dir.ts`). */
export function traceSecretPath(dataPath: string): string {
  return resolve(dataPath, "trace-secret");
}

/** The instance's trace secret, made and stored on first use. Throws when the file exists but doesn't hold one. */
export async function loadTraceSecret(dataPath: string): Promise<string> {
  const path = traceSecretPath(dataPath);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing !== undefined) {
    const secret = existing.trim();
    if (!SECRET_SHAPE.test(secret)) throw new Error(`${path} doesn't hold a trace secret; delete it to have a new one made`);
    return secret;
  }
  const secret = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${secret}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return secret;
}
