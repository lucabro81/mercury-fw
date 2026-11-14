/**
 * Locked notes: the ones only people change. A note is locked when its
 * frontmatter says `locked: true` (on a curated note, set by whoever curates
 * the wiki; on a person's note, by the person) or when it's under one of the
 * instance's `locked` paths (`wiki({ locked })`, for whole folders of
 * `curated/` copied from an official source). The nightly review and the
 * dreaming pass leave a locked note alone.
 */
import { readNote } from "./wiki-note.ts";

/** Throws, naming it, for a configured path that isn't under `curated/`. */
export function assertLockPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (!path.startsWith("curated/") || path === "curated/") {
      throw new Error(`wiki: locked takes paths under curated/ (got "${path}")`);
    }
  }
}

/** Whether the note at a vault path (`curated/…`, `users/<key>/notes/…`) is locked, by the configured `paths` or its frontmatter. */
export function createLockCheck(vaultPath: string, paths: readonly string[]): (path: string) => Promise<boolean> {
  const globs = paths.map((p) => new Bun.Glob(p));
  return async (path) => {
    if (globs.some((glob) => glob.match(path))) return true;
    try {
      const note = await readNote(vaultPath, path);
      return note?.frontmatter.locked === true;
    } catch {
      // A note it can't read might be locked: closed, so nothing writes over it.
      return true;
    }
  };
}
