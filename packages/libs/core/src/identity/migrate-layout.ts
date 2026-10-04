/**
 * Moves what an instance stored before the user key existed onto it, at
 * startup. Before, a person was their bare channel id: raw in episodic memory
 * and semantic facts (`users/42`), encoded in the verbatim archive and the
 * vault (`users%2F42`, and twice encoded for staged confirmation notes), with
 * the vault's per-person notes under `inferred/users/<id>/` and
 * `inferred/confirmations/<id>/`.
 *
 * Only what can be attributed moves: a Google Chat id (`users/<n>`) and the
 * terminal. Any other bare id could belong to more than one provider, so it's
 * left where it is and logged. Idempotent (a user key is never touched again)
 * and fail-soft: a failure is logged, and Mercury starts anyway.
 */
import { mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { changeVaultAndCommit } from "../wiki/wiki-note.ts";
import { userArea } from "./user-key.ts";

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
  if (moved.size > 0) {
    log(`moved ${moved.size} notes of ${people.size} ${people.size === 1 ? "person" : "people"} into users/<key>/`);
  }
}

type ScrollOffset = string | number | Record<string, unknown> | null | undefined;

/** The slice of the Qdrant client the memory migration uses. */
export type MigrationQdrant = {
  scroll(
    collection: string,
    params: { limit: number; offset?: ScrollOffset; with_payload: string[]; with_vector: false },
  ): Promise<{ points: Array<{ payload?: Record<string, unknown> | null }>; next_page_offset?: ScrollOffset }>;
  setPayload(
    collection: string,
    params: { payload: { userId: string }; filter: { must: Array<{ key: string; match: { value: string } }> }; wait: boolean },
  ): Promise<unknown>;
};

/** The distinct `userId`s in `collection`, scrolling every page. */
async function userIdsIn(client: MigrationQdrant, collection: string): Promise<string[]> {
  const ids = new Set<string>();
  let offset: ScrollOffset;
  do {
    const page = await client.scroll(collection, { limit: 256, offset, with_payload: ["userId"], with_vector: false });
    for (const point of page.points) {
      const userId = point.payload?.userId;
      if (typeof userId === "string") ids.add(userId);
    }
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);
  return [...ids];
}

/** Rewrites every legacy `userId` in `collections` that can be attributed to its user key. */
export async function migrateMemoryToUserKeys(
  client: MigrationQdrant,
  collections: string[],
  log: (msg: string) => void,
): Promise<void> {
  let rewritten = 0;
  for (const collection of collections) {
    try {
      for (const userId of await userIdsIn(client, collection)) {
        // Every user key has a ":", no legacy id did.
        if (userId.includes(":")) continue;
        const key = legacyUserKey(userId);
        if (key === undefined) {
          log(`${collection}: left userId "${userId}" as it is: ${UNATTRIBUTABLE}`);
          continue;
        }
        await client.setPayload(collection, {
          payload: { userId: key },
          filter: { must: [{ key: "userId", match: { value: userId } }] },
          wait: true,
        });
        rewritten += 1;
      }
    } catch (err) {
      log(`${collection}: migration skipped: ${String(err)}`);
    }
  }
  if (rewritten > 0) log(`rewrote ${rewritten} legacy userIds to user keys`);
}
