/**
 * Read-side access to the wiki vault: listing, reading, and searching, each
 * scoped to the roots the caller passes. What a person can see is decided in
 * `identity/vault-access.ts`, which builds on these; the nightly self-review
 * uses `selfReviewRoots`. Plain functions, not model-invocable tools.
 */
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** curated/ + raw/ only, for the nightly self-review job: never a person's
 * area under users/, so a review can't merge what belongs to one person into
 * the common area or into someone else's. */
export function selfReviewRoots(vaultPath: string): string[] {
  const vaultRoot = resolve(vaultPath);
  return [resolve(vaultRoot, "curated"), resolve(vaultRoot, "raw")];
}

/**
 * Resolves `relativePath` against the vault and checks it falls under
 * one of `roots`: rejects both vault escape (`..`) and access outside
 * the caller's declared scope.
 */
function resolveAllowedWikiPath(vaultPath: string, roots: string[], relativePath: string): string {
  const vaultRoot = resolve(vaultPath);
  const target = resolve(vaultRoot, relativePath);
  const allowed = roots.some((root) => target === root || target.startsWith(root + sep));
  if (!allowed) {
    throw new Error(`path not accessible: ${relativePath}`);
  }
  return target;
}

async function listFilesUnder(root: string, vaultRoot: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const glob = new Bun.Glob("**/*.md");
  const results: string[] = [];
  for await (const rel of glob.scan({ cwd: root })) {
    results.push(relative(vaultRoot, join(root, rel)));
  }
  return results;
}

/** Lists every `.md` file under `roots`. */
export async function listWikiFilesInRoots(vaultPath: string, roots: string[]): Promise<string[]> {
  const vaultRoot = resolve(vaultPath);
  const lists = await Promise.all(roots.map((root) => listFilesUnder(root, vaultRoot)));
  return lists.flat().sort();
}

/** Reads a single wiki file. Throws if `relativePath` falls outside `roots`. */
export async function readWikiFileInRoots(vaultPath: string, roots: string[], relativePath: string): Promise<string> {
  const fullPath = resolveAllowedWikiPath(vaultPath, roots, relativePath);
  return readFile(fullPath, "utf-8");
}

export type WikiGrepMatch = { path: string; line: number; text: string };

/** Searches every file under `roots` for `pattern` (a regular expression,
 * case-insensitive: a note's wording isn't the question's), line by line. */
export async function grepWikiInRoots(vaultPath: string, roots: string[], pattern: string): Promise<WikiGrepMatch[]> {
  const regex = new RegExp(pattern, "i");
  const files = await listWikiFilesInRoots(vaultPath, roots);
  const matches: WikiGrepMatch[] = [];

  for (const file of files) {
    const content = await readWikiFileInRoots(vaultPath, roots, file);
    const lines = content.split("\n");
    lines.forEach((text, index) => {
      if (regex.test(text)) {
        matches.push({ path: file, line: index + 1, text });
      }
    });
  }

  return matches;
}

/** Reads index.md at the vault root; empty string if it doesn't exist yet (a brand-new vault, or one where self-review hasn't created it). */
export async function readIndexFile(vaultPath: string): Promise<string> {
  try {
    return await readFile(resolve(vaultPath, "index.md"), "utf-8");
  } catch {
    return "";
  }
}
