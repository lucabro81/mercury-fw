/**
 * The confirmation notes: one file per confirm-required action, in the data
 * folder under `confirmations/<person's key, encoded>/<token>.md`, written
 * when the action is staged (`pending`) and overwritten when it's resolved
 * (`confirmed` or `failed`). They're the paper trail the primer's "Open
 * references" and `resolve_reference` read; the model never browses them.
 *
 * An older instance kept them in the wiki's vault, under
 * `users/<key>/confirmations/`; `copyVaultConfirmations` copies them over once.
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** What a note records about its action. */
export type ConfirmationNoteFields = {
  status: "pending" | "confirmed" | "failed";
  requestedAt: string;
  resolvedAt: string | null;
  command: string;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

/** Where the notes live in the data folder `dataPath`. */
export function confirmationNotesRoot(dataPath: string): string {
  return resolve(dataPath, "confirmations");
}

/** The folder of the person `key`'s notes, the key encoded as the vault did. */
function personFolder(root: string, key: string): string {
  return resolve(root, encodeURIComponent(key));
}

/** The file of `token` in the person's folder; throws for a token that names a path. */
function notePath(root: string, key: string, token: string): string {
  if (token === "" || token === "." || token === ".." || /[/\\]/.test(token)) {
    throw new Error(`not a confirmation token: ${JSON.stringify(token)}`);
  }
  return resolve(personFolder(root, key), `${token}.md`);
}

/** Writes (or overwrites) the note of `token` for the person `key`. */
export async function writeConfirmationNote(root: string, key: string, token: string, fields: ConfirmationNoteFields): Promise<void> {
  const path = notePath(root, key, token);
  const frontmatter = {
    type: "confirmation",
    status: fields.status,
    requested_at: fields.requestedAt,
    resolved_at: fields.resolvedAt,
    command: fields.command,
  };
  await mkdir(personFolder(root, key), { recursive: true });
  await writeFile(path, `---\n${stringifyYaml(frontmatter)}---\n\n\n`);
}

/** The text of the person `key`'s note for `token`; throws when they have none. */
export async function readConfirmationNote(root: string, key: string, token: string): Promise<string> {
  return readFile(notePath(root, key, token), "utf8");
}

/** The tokens of the person `key`'s notes still `pending`; none when they have no folder. */
export async function pendingConfirmationTokens(root: string, key: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(personFolder(root, key));
  } catch {
    return [];
  }
  const tokens: string[] = [];
  for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
    const match = FRONTMATTER_RE.exec(await readFile(resolve(personFolder(root, key), file), "utf8"));
    if (!match) continue;
    const frontmatter = parseYaml(match[1] as string) as { status?: unknown } | null;
    if (frontmatter?.status === "pending") tokens.push(file.replace(/\.md$/, ""));
  }
  return tokens;
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Copies the notes an older instance kept in the vault
 * (`<vaultPath>/users/<key>/confirmations/`) into `notesRoot`, leaving the
 * originals, and returns how many it copied. Acts only while `notesRoot`
 * doesn't exist, and creates it either way, so it runs on every start and
 * copies at most once. The copy goes to a folder next to it, renamed into
 * place when done: one that fails leaves nothing behind and throws, and the
 * next start tries again. `copy` is a test seam.
 */
export async function copyVaultConfirmations(deps: {
  vaultPath?: string;
  notesRoot: string;
  log: (msg: string) => void;
  copy?: (from: string, to: string) => Promise<void>;
}): Promise<number> {
  const copy = deps.copy ?? ((from, to) => cp(from, to, { recursive: true, preserveTimestamps: true }));
  const root = resolve(deps.notesRoot);
  if (await exists(root)) return 0;
  const partial = `${root}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  let copied = 0;
  try {
    if (deps.vaultPath !== undefined) {
      const users = resolve(deps.vaultPath, "users");
      for (const person of (await readdir(users).catch(() => [] as string[])).sort()) {
        const from = resolve(users, person, "confirmations");
        const notes = (await readdir(from).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));
        if (notes.length === 0) continue;
        await copy(from, resolve(partial, person));
        copied += notes.length;
      }
    }
    await rename(partial, root);
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw new Error(`couldn't copy the confirmation notes from the vault to ${root}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (copied > 0) deps.log(`copied ${copied} confirmation note(s) from the vault to ${root}; the originals are left where they are`);
  return copied;
}
