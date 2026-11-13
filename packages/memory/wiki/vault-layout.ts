/**
 * Moves the vault's per-person notes from the layout before the user key
 * existed (`inferred/users/<id>/`, `inferred/confirmations/<id>/`) into each
 * person's area, `users/<key>/`, at startup, as one commit. Only what can be
 * attributed moves: a Google Chat id (`users/<n>`) and the terminal. Any other
 * bare id could belong to more than one provider, so it's left where it is and
 * logged. Idempotent (a user key is never touched again).
 */
import { mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { userArea } from "./user-area.ts";
import { changeVaultAndCommit } from "./wiki-note.ts";

/** The user key a pre-key id stands for, decoding it as many times as it was encoded; `undefined` when it can't be attributed. */
export function legacyUserKey(id: string): string | undefined {
  let decoded = id;
  for (;;) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (/^users\/[^/]+$/.test(decoded)) return `google-chat:${decoded}`;
  if (decoded === "terminal") return "none:terminal";
  return undefined;
}

const UNATTRIBUTABLE = "can't tell whose it is (an id without its provider)";

/** The legacy per-person folders, and where their files go inside a person's area. */
const LEGACY_FOLDERS = [
  { from: "inferred/users", to: "inferred" },
  { from: "inferred/confirmations", to: "confirmations" },
];

/** Every file below `dir`, relative to it. */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** True when `path` is a confirmation note still marked pending. */
async function isPending(path: string): Promise<boolean> {
  return /^status: pending$/m.test(await readFile(path, "utf-8"));
}

/** Removes `dir` if it's an empty folder; anything else is left alone. */
async function removeIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch(() => {});
}

/** Moves the vault's legacy per-person folders into `users/<key>/`, as one commit. */
export async function migrateVaultToUserAreas(vaultPath: string, log: (msg: string) => void): Promise<void> {
  const moved = new Set<string>();
  const people = new Set<string>();
  const left: string[] = [];
  const dropped: string[] = [];

  await changeVaultAndCommit(vaultPath, "migrate: per-person notes into users/<key>/", async () => {
    for (const { from, to } of LEGACY_FOLDERS) {
      const root = join(vaultPath, from);
      const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const dir of dirs.filter((d) => d.isDirectory())) {
        const key = legacyUserKey(dir.name);
        if (key === undefined) {
          left.push(`${from}/${dir.name}`);
          continue;
        }
        const source = join(root, dir.name);
        const target = join(vaultPath, userArea(key), to);
        for (const file of await filesBelow(source)) {
          const src = join(source, file);
          const dst = join(target, file);
          // The double encoding left a pending note in one folder and its
          // resolution in another: the resolved one wins, either way round.
          const taken = await readFile(dst, "utf-8").then(
            () => true,
            () => false,
          );
          if (taken && !((await isPending(dst)) && !(await isPending(src)))) {
            // A stale pending copy goes quietly; anything else is worth a line.
            if (!(await isPending(src))) {
              dropped.push(`dropped ${relative(vaultPath, src)}: ${relative(vaultPath, dst)} already exists (the vault's git history keeps it)`);
            }
            await rm(src);
            continue;
          }
          await mkdir(dirname(dst), { recursive: true });
          await rename(src, dst);
          moved.add(dst);
          people.add(key);
        }
        await rm(source, { recursive: true, force: true });
      }
      await removeIfEmpty(root);
    }
    await removeIfEmpty(join(vaultPath, "inferred"));
  });

  for (const path of left) log(`left ${path} in place: ${UNATTRIBUTABLE}`);
  for (const line of dropped) log(line);
  if (moved.size > 0) {
    const notes = moved.size === 1 ? "note" : "notes";
    log(`moved ${moved.size} ${notes} of ${people.size} ${people.size === 1 ? "person" : "people"} into users/<key>/`);
  }
}
