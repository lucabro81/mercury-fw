/**
 * A person's area in the vault: `users/<key>/`, the key (`<provider>:<id>`,
 * the core's user key) encoded so it's one folder name whatever it holds.
 */

/** The vault-relative folder of the person `key`. */
export function userArea(key: string): string {
  return `users/${encodeURIComponent(key)}`;
}
