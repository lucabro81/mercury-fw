/**
 * Read-side access to the wiki vault: listing, reading, and searching.
 * Every function is scoped to `curated/` (visible to everyone) plus
 * `inferred/users/<userId>/` for the *calling* userId only — never
 * another user's semantic notes (the same per-user isolation already
 * used for Layer 3/Qdrant, applied to Layer 2 too). Plain
 * functions, not model-invocable tools — wiki-tools.ts wraps a subset of
 * these in `tool()` for the model, same split as
 * cli-executor.ts/cli-tool.ts.
 */
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { assertNoPathSeparator } from "./wiki-note.ts";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function allowedRoots(vaultPath: string, userId: string): string[] {
  assertNoPathSeparator("userId", userId);
  const vaultRoot = resolve(vaultPath);
  return [resolve(vaultRoot, "curated"), resolve(vaultRoot, "inferred", "users", userId)];
}

/** curated/ + raw/ only — never inferred/, for the nightly self-review job.
 * A distinct trust boundary from a per-user conversation's `allowedRoots`
 * (which trades curated/ for one user's own inferred/ instead of raw/):
 * inferred/ is meant to hold only deterministic, mechanically-written
 * notes (never an LLM's own judgment call about what to remember) —
 * off-limits here for the same reason it's off-limits to regular
 * conversations, not a special exception for self-review. */
export function selfReviewRoots(vaultPath: string): string[] {
  const vaultRoot = resolve(vaultPath);
  return [resolve(vaultRoot, "curated"), resolve(vaultRoot, "raw")];
}

/**
 * Resolves `relativePath` against the vault and checks it falls under
 * one of `roots` — rejects both vault escape (`..`) and access outside
 * the caller's declared scope (cross-user inferred/ access, or anything
 * outside curated/+raw/ for the self-review job).
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

/** Lists every `.md` file visible to `userId`: all of curated/, plus only their own inferred/users/<userId>/. */
export async function listWikiFiles(vaultPath: string, userId: string): Promise<string[]> {
  return listWikiFilesInRoots(vaultPath, allowedRoots(vaultPath, userId));
}

/** Reads a single wiki file. Throws if `relativePath` falls outside `roots`. */
export async function readWikiFileInRoots(vaultPath: string, roots: string[], relativePath: string): Promise<string> {
  const fullPath = resolveAllowedWikiPath(vaultPath, roots, relativePath);
  return readFile(fullPath, "utf-8");
}

/** Reads a single wiki file. Throws if `relativePath` falls outside the caller's allowed scope. */
export async function readWikiFile(vaultPath: string, userId: string, relativePath: string): Promise<string> {
  return readWikiFileInRoots(vaultPath, allowedRoots(vaultPath, userId), relativePath);
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

/** Searches every file visible to `userId` for `pattern` (a regular expression), line by line. */
export async function grepWiki(vaultPath: string, userId: string, pattern: string): Promise<WikiGrepMatch[]> {
  return grepWikiInRoots(vaultPath, allowedRoots(vaultPath, userId), pattern);
}

/** Reads index.md at the vault root; empty string if it doesn't exist yet (a brand-new vault, or one where self-review hasn't created it). */
export async function readIndexFile(vaultPath: string): Promise<string> {
  try {
    return await readFile(resolve(vaultPath, "index.md"), "utf-8");
  } catch {
    return "";
  }
}
