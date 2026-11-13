/**
 * Moves what an instance stored before the user key existed onto it, at
 * startup. Before, a person was their bare channel id: raw in episodic memory
 * and semantic facts (`users/42`), encoded in the verbatim archive
 * (`users%2F42`). The wiki moves its own notes (see `@mercury-fw/wiki`).
 *
 * Only what can be attributed moves: a Google Chat id (`users/<n>`) and the
 * terminal. Any other bare id could belong to more than one provider, so it's
 * left where it is and logged. Idempotent (a user key is never touched again)
 * and fail-soft: a failure is logged, and Mercury starts anyway.
 */
import type { VectorIndex } from "@mercury-fw/plugin-types";

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

/** The slice of the vector index the memory migration uses. */
export type MigrationIndex = Pick<VectorIndex, "scroll" | "setPayload">;

/** The distinct `userId`s in `space`, scrolling every page. */
async function userIdsIn(index: MigrationIndex, space: string): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await index.scroll(space, { limit: 256, ...(cursor === undefined ? {} : { cursor }) });
    for (const point of page.points) {
      const userId = point.payload.userId;
      if (typeof userId === "string") ids.add(userId);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return [...ids];
}

/** Rewrites every legacy `userId` in `spaces` that can be attributed to its user key. */
export async function migrateMemoryToUserKeys(
  index: MigrationIndex,
  spaces: string[],
  log: (msg: string) => void,
): Promise<void> {
  let rewritten = 0;
  for (const space of spaces) {
    try {
      for (const userId of await userIdsIn(index, space)) {
        // Every user key has a ":", no legacy id did.
        if (userId.includes(":")) continue;
        const key = legacyUserKey(userId);
        if (key === undefined) {
          log(`${space}: left userId "${userId}" as it is: ${UNATTRIBUTABLE}`);
          continue;
        }
        await index.setPayload(space, { where: { userId }, payload: { userId: key } });
        rewritten += 1;
      }
    } catch (err) {
      log(`${space}: migration skipped: ${String(err)}`);
    }
  }
  if (rewritten > 0) log(`rewrote ${rewritten} legacy userIds to user keys`);
}
