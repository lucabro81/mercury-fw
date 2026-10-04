/**
 * The single decision point for what a person sees of the wiki vault: the
 * common area (`curated/`) and their own area (`users/<key>/`), which they
 * address as `personal/` so the key never shows up in a path. Both the model's
 * wiki tools and the HTTP reads go through here; a path outside the scope is
 * refused as if it didn't exist.
 *
 * Inside a person's area only `notes/` (what the model writes for them) and
 * `inferred/` (what consolidation derives) are visible; `confirmations/` is
 * reached by token only (`resolve_reference`), never by browsing.
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { grepWikiInRoots, listWikiFilesInRoots, type WikiGrepMatch } from "../wiki/wiki-read.ts";
import { userArea } from "./user-key.ts";

/** Whose view of which vault. */
export type VaultScope = { vaultPath: string; key: string };

const PERSONAL = "personal";
const VISIBLE_IN_AREA = ["notes", "inferred"];

/** True when `target` is `root` or below it. */
function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** The absolute folders `scope` can read: the common area, then the visible parts of the person's area. */
function visibleRoots(scope: VaultScope): string[] {
  const vault = resolve(scope.vaultPath);
  return [resolve(vault, "curated"), ...VISIBLE_IN_AREA.map((dir) => resolve(vault, userArea(scope.key), dir))];
}

/** `path` as the person names it, resolved to an absolute file they can read; throws `path not accessible` otherwise. */
function resolveVisible(scope: VaultScope, path: string): string {
  const vault = resolve(scope.vaultPath);
  const [head, ...rest] = path.split("/");
  const [curated, ...personal] = visibleRoots(scope);
  let target: string | undefined;
  if (head === "curated") {
    const candidate = resolve(vault, path);
    if (within(curated!, candidate) && candidate !== curated) target = candidate;
  } else if (head === PERSONAL) {
    const candidate = resolve(vault, userArea(scope.key), rest.join("/"));
    if (personal.some((root) => within(root, candidate) && candidate !== root)) target = candidate;
  }
  if (target === undefined) throw new Error(`path not accessible: ${path}`);
  return target;
}

/** A vault-relative path as the person names it: their own area becomes `personal/`. */
function toVisible(scope: VaultScope, vaultRelative: string): string {
  const area = `${userArea(scope.key)}/`;
  return vaultRelative.startsWith(area) ? `${PERSONAL}/${vaultRelative.slice(area.length)}` : vaultRelative;
}

/** Every `.md` file `scope` can read, as they'd name it, sorted. */
export async function listVisible(scope: VaultScope): Promise<string[]> {
  const files = await listWikiFilesInRoots(scope.vaultPath, visibleRoots(scope));
  return files.map((file) => toVisible(scope, file)).sort();
}

/** The content of `path`, named as the person names it. */
export async function readVisible(scope: VaultScope, path: string): Promise<string> {
  return readFile(resolveVisible(scope, path), "utf-8");
}

/** Lines matching `pattern` (a regular expression, case ignored) in what `scope` can read. */
export async function grepVisible(scope: VaultScope, pattern: string): Promise<WikiGrepMatch[]> {
  const matches = await grepWikiInRoots(scope.vaultPath, visibleRoots(scope), pattern);
  return matches.map((match) => ({ ...match, path: toVisible(scope, match.path) }));
}

/** The content of one of the person's notes (below `personal/notes/`), checked after resolving the path so `..` can't reach anything else; throws otherwise. */
export async function readPersonalNote(scope: VaultScope, path: string): Promise<string> {
  const target = resolveVisible(scope, path);
  if (!within(resolve(scope.vaultPath, userArea(scope.key), "notes"), target)) {
    throw new Error(`only a note under personal/notes/ can be promoted: ${path}`);
  }
  return readFile(target, "utf-8");
}

/** The person's consolidated note on `topic` (`users/<key>/inferred/<topic>.md`), for consolidation to compare against; throws when there is none. */
export async function readInferredNote(vaultPath: string, key: string, topic: string): Promise<string> {
  return readVisible({ vaultPath, key }, `${PERSONAL}/inferred/${topic}.md`);
}

/** The person's own confirmation note for `token`, the only way to reach their `confirmations/` folder; throws when there is none. */
export async function readConfirmationNote(vaultPath: string, key: string, token: string): Promise<string> {
  const confirmations = resolve(vaultPath, userArea(key), "confirmations");
  const target = resolve(confirmations, `${token}.md`);
  if (!within(confirmations, target) || target === confirmations) throw new Error(`no confirmation ${token}`);
  return readFile(target, "utf-8");
}

/** `path` as a destination in the common area, relative to `curated/` (a leading `curated/` is accepted and dropped); throws when it would land anywhere else, or isn't a `.md` file (the only ones listing and grep see). */
export function curatedDestination(vaultPath: string, path: string): string {
  const relativePath = path.replace(/^curated\//, "");
  const curated = resolve(vaultPath, "curated");
  const target = resolve(curated, relativePath);
  if (!within(curated, target) || target === curated || relativePath.endsWith("/")) {
    throw new Error(`not a destination in the common area: ${path}`);
  }
  if (!relativePath.endsWith(".md")) throw new Error(`not a .md file: ${path}`);
  return relativePath;
}

/** The absolute file a write to `path` lands on: only below `personal/notes/`, the one place the model writes for a person. */
export function personalNotePath(vaultPath: string, key: string, path: string): string {
  if (path.split("/")[0] === "curated") {
    throw new Error("curated/ is the common area: write under personal/notes/ and use promote_note to share it");
  }
  const notes = resolve(vaultPath, userArea(key), "notes");
  const [head, ...rest] = path.split("/");
  const target = resolve(vaultPath, userArea(key), rest.join("/"));
  if (head !== PERSONAL || !within(notes, target) || target === notes || path.endsWith("/")) {
    throw new Error(`not writable: ${path} (write under personal/notes/)`);
  }
  if (!path.endsWith(".md")) throw new Error(`not a .md file: ${path}`);
  return target;
}
