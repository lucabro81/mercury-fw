/**
 * The one identity the core keeps for a person: `<provider>:<id>`, so two
 * providers issuing the same id stay two people. Memory (Qdrant's `userId`)
 * stores the key raw; the vault stores a person's files under `userArea(key)`,
 * the only place the key gets encoded.
 */
import type { Principal } from "@mercury-fw/channel-types";

/** The key every per-person store uses for `principal`. `toWellFormed` keeps a lone surrogate from making a later encoding throw. */
export function userKey(principal: Principal): string {
  return `${principal.provider}:${principal.id.toWellFormed()}`;
}

/** The vault folder holding `key`'s files, relative to the vault root: always one segment under `users/`, since the key always contains a `:`. */
export function userArea(key: string): string {
  return `users/${encodeURIComponent(key)}`;
}
