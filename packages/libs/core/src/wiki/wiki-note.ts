/**
 * Typed writers for wiki notes — the "template" that takes
 * structured fields instead of a free-form file write: each function
 * validates its fields against the frontmatter schema
 * (frontmatter-schema.ts), serializes YAML frontmatter + markdown body,
 * and writes the result under the vault path (vault-init.ts creates the
 * surrounding curated/inferred directories).
 *
 * These are plain functions, not model-invocable tools — mirrors the
 * split already used for CLIs (cli-executor.ts/command-parser.ts do the
 * work, cli-tool.ts wraps a subset in `tool()` for the model). Whether
 * either of these gets a `tool()` wrapper is a separate, later decision:
 * `writeInferredNote` in particular must stay internal-only, called
 * exclusively by the deterministic consolidation engine — never
 * exposed to the model, since that would reopen the question of letting
 * the LLM decide when to write semantic memory, deliberately kept
 * mechanical/deterministic instead.
 *
 * Path segments coming from outside Mercury's own code (userId, topic)
 * are resolved and checked against the vault root before any write — a
 * topic string is LLM-produced free text, nothing upstream guarantees
 * it can't contain `..` or `/`.
 */
import { mkdir, writeFile, stat, readFile, rename, rm } from "node:fs/promises";
import { resolve, sep, dirname, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  CuratedFrontmatterSchema,
  PersonalFrontmatterSchema,
  InferredFrontmatterSchema,
  ConfirmationFrontmatterSchema,
  type CuratedFrontmatter,
  type PersonalFrontmatter,
  type InferredFrontmatter,
  type ConfirmationFrontmatter,
} from "./frontmatter-schema.ts";
import { userArea } from "../identity/user-key.ts";
import { personalNotePath } from "../identity/vault-access.ts";

/**
 * Resolves `segments` against `root` and checks the result stays inside
 * `root` — not just inside the vault as a whole. `root` must already be
 * the *specific* subtree a given write is scoped to (`curated/`, or one
 * person's `users/<key>/inferred/`): checking only against the vault
 * root would let a relativePath like `"../users/x/notes/y.md"` escape
 * `curated/` while still landing somewhere else inside the vault.
 */
function resolveWithinRoot(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new Error(`refusing to write outside ${root}: ${segments.join("/")}`);
  }
  return target;
}

/** Throws unless `value` is exactly one non-empty path segment (no separator, not `.` or `..`). */
export function assertNoPathSeparator(label: string, value: string): void {
  if (value === "" || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Mercury's own git identity, passed inline on every commit (`-c
// user.email=...`) rather than relying on global/system git config —
// self-contained, works the same in a fresh dev checkout, in tests, and in
// any deployment, with nothing to set up out-of-band. Distinct from any
// human's own git identity, so `git log --author`/`git blame` cleanly
// separate Mercury's automated writes from a maintainer's — the actual
// provenance mechanism the vault's audit trail already relies on, not
// a schema-level flag.
const MERCURY_GIT_AUTHOR = { email: "mercury@mercury.local", name: "Mercury" };

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    // git prints some failure reasons (e.g. "nothing to commit") to
    // stdout, not stderr — found by hand via the maintenance CLI, where a
    // stderr-only message came back empty and gave no clue what failed.
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || stdout}`);
  }
}

/** True if `git add` staged at least one real change — i.e. there's
 * something for `git commit` to actually record. */
async function hasStagedChanges(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "diff", "--cached", "--quiet"], { cwd });
  const exitCode = await proc.exited;
  return exitCode !== 0; // --quiet: 0 = no differences, 1 = differences
}

// git add/commit against the same repo aren't safe to run concurrently
// (index lock races) — every writer below shares one vault/repo, so this
// chain is shared across all of them, not per-function. `.then(fn, fn)`
// runs the next write regardless of whether the previous one succeeded or
// failed, so one bad commit doesn't wedge every write after it; the
// rejection itself still propagates to that specific caller via `result`.
// If the file write already landed on disk before a later git step throws
// (disk full, corrupt repo), `writeNoteFile` logs a dedicated
// `[wiki-vault] ... written to disk but not committed` line before
// rethrowing — distinguishable from a generic failure by whatever reads
// stderr (`docker compose logs` today; the admin-notification path this
// could eventually route through isn't wired up for this specific
// signal yet).
let commitChain: Promise<void> = Promise.resolve();

function serializeCommit<T>(fn: () => Promise<T>): Promise<T> {
  const result = commitChain.then(fn, fn);
  commitChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Decides on a file's current content (`null` when it doesn't exist) whether
 * a write or delete goes ahead. It runs inside the commit chain, so nothing
 * else touches the vault between the decision and the write: a
 * read-compare-write can't lose a concurrent update.
 */
export type WriteCondition = { when?: (current: string | null) => boolean };

/** The file's content, or `null` when there's no file; any other read error
 * throws, since a file that's there but unreadable isn't a missing one. */
async function readCurrent(fullPath: string): Promise<string | null> {
  try {
    return await readFile(fullPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Replaces `fullPath` with `content` through a temporary file in the same
 * folder and a rename, so a reader that doesn't wait for the chain (the wiki
 * tools, the context primer) never sees a half-written file.
 */
async function replaceFile(fullPath: string, content: string): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true });
  const temporary = `${fullPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf-8");
    await rename(temporary, fullPath);
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }
}

/** Stages `fullPath` and commits it as `commitMessage`, unless the content is what's already committed. */
async function commitFile(vaultPath: string, fullPath: string, commitMessage: string): Promise<void> {
  const relPath = relative(vaultPath, fullPath);
  try {
    await runGit(vaultPath, ["add", relPath]);
    // Byte-identical content to what's already committed stages no diff —
    // asking the vault to contain X when it already contains exactly X is
    // a no-op, not a failure, so skip the commit instead of letting `git
    // commit` fail with "nothing to commit".
    if (!(await hasStagedChanges(vaultPath))) {
      return;
    }
    await runGit(vaultPath, [
      "-c",
      `user.email=${MERCURY_GIT_AUTHOR.email}`,
      "-c",
      `user.name=${MERCURY_GIT_AUTHOR.name}`,
      "commit",
      "-m",
      commitMessage,
    ]);
  } catch (err) {
    console.error(`[wiki-vault] ${relPath} written to disk but not committed: ${String(err)}`);
    throw err;
  }
}

/**
 * Every vault write is a commit — audit trail + `git revert` as a
 * safety net. The file write itself goes through the same queue as the
 * commit (not just git add/commit) — two writers targeting the same path
 * must never race directly on disk content; queuing only the git half
 * left that race open (found and fixed later). This makes "two
 * writers, one path" deterministic (whichever is processed second wins,
 * cleanly) rather than a data-loss race with confusing spurious errors —
 * it does not attempt any merge of old vs new content, by design. A caller
 * whose write depends on what's there passes `when`, decided inside the
 * queue. Resolves `false` when `when` skipped the write.
 */
async function writeVerbatimFile(
  vaultPath: string,
  fullPath: string,
  content: string,
  commitMessage: string,
  condition: WriteCondition = {},
): Promise<boolean> {
  return serializeCommit(async () => {
    if (condition.when && !condition.when(await readCurrent(fullPath))) return false;
    await replaceFile(fullPath, content);
    await commitFile(vaultPath, fullPath, commitMessage);
    return true;
  });
}

async function writeNoteFile(
  vaultPath: string,
  fullPath: string,
  frontmatter: CuratedFrontmatter | PersonalFrontmatter | InferredFrontmatter | ConfirmationFrontmatter,
  body: string,
  commitMessage: string,
  condition: WriteCondition = {},
): Promise<boolean> {
  const content = `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`;
  return writeVerbatimFile(vaultPath, fullPath, content, commitMessage, condition);
}

/**
 * Runs `change` (any rearrangement of the vault's files) on the same queue as
 * every writer, then stages everything and commits it as one `message` when
 * it changed something. For maintenance that moves files around in bulk, such
 * as a layout migration, so it lands as one revertable commit.
 */
export async function changeVaultAndCommit(vaultPath: string, message: string, change: () => Promise<void>): Promise<void> {
  await serializeCommit(async () => {
    await change();
    await runGit(vaultPath, ["add", "-A"]);
    if (!(await hasStagedChanges(vaultPath))) return;
    await runGit(vaultPath, [
      "-c",
      `user.email=${MERCURY_GIT_AUTHOR.email}`,
      "-c",
      `user.name=${MERCURY_GIT_AUTHOR.name}`,
      "commit",
      "-m",
      message,
    ]);
  });
}

/** `git rm` + commit through the same queue as every writer above, so
 * the same `git revert` safety net covers deletions too. A target already gone
 * is a no-op success, not an error — same philosophy as the byte-identical
 * write no-op above. Resolves `false` when `when` kept the file. */
async function deleteVaultFile(
  vaultPath: string,
  fullPath: string,
  commitMessage: string,
  condition: WriteCondition = {},
): Promise<boolean> {
  return serializeCommit(async () => {
    if (condition.when && !condition.when(await readCurrent(fullPath))) return false;
    if (!(await pathExists(fullPath))) return true;
    const relPath = relative(vaultPath, fullPath);
    await runGit(vaultPath, ["rm", "--quiet", relPath]);
    await runGit(vaultPath, [
      "-c",
      `user.email=${MERCURY_GIT_AUTHOR.email}`,
      "-c",
      `user.name=${MERCURY_GIT_AUTHOR.name}`,
      "commit",
      "-m",
      commitMessage,
    ]);
    return true;
  });
}

/** `path` relative to curated/: a vault-relative one (`curated/x.md`, as
 * listing, reading and grepping give it) loses its leading `curated/`. */
export function relativeToCurated(path: string): string {
  return path.replace(/^curated\//, "");
}

/** Writes a curated doc at `curated/<relativePath>` (e.g. "standards/jira-fields.md"). */
export async function writeCuratedNote(
  vaultPath: string,
  relativePath: string,
  fields: { author?: string; last_updated?: string },
  body: string,
  condition: WriteCondition = {},
): Promise<boolean> {
  const frontmatter = CuratedFrontmatterSchema.parse({ type: "curated", ...fields });
  const curatedRoot = resolve(vaultPath, "curated");
  const fullPath = resolveWithinRoot(curatedRoot, relativePath);
  return writeNoteFile(vaultPath, fullPath, frontmatter, body, `curated: ${relativePath}`, condition);
}

/** Writes a note the model asked for on behalf of the person `key`, at `path` as the person names it: only below `personal/notes/` (see `personalNotePath`). */
export async function writePersonalNote(
  vaultPath: string,
  key: string,
  path: string,
  fields: { last_updated?: string },
  body: string,
): Promise<void> {
  const fullPath = personalNotePath(vaultPath, key, path);
  const frontmatter = PersonalFrontmatterSchema.parse({ type: "personal", ...fields });
  const notesRelative = relative(resolve(vaultPath, userArea(key), "notes"), fullPath);
  await writeNoteFile(vaultPath, fullPath, frontmatter, body, `personal: ${key}/${notesRelative}`);
}

/** Writes a semantic note for the person `key` at `<userArea(key)>/inferred/<topic>.md`. */
export async function writeInferredNote(
  vaultPath: string,
  key: string,
  topic: string,
  fields: { confidence: "low" | "medium" | "high"; derived_from: string[]; last_reviewed: string | null },
  body: string,
  condition: WriteCondition = {},
): Promise<boolean> {
  assertNoPathSeparator("topic", topic);
  const frontmatter = InferredFrontmatterSchema.parse({ type: "inferred", source: "agent", ...fields });
  const inferredRoot = resolve(vaultPath, userArea(key), "inferred");
  const fullPath = resolveWithinRoot(inferredRoot, `${topic}.md`);
  return writeNoteFile(vaultPath, fullPath, frontmatter, body, `inferred: ${key}/${topic}`, condition);
}

/**
 * Writes a deterministically-promoted procedural correction at
 * `curated/standards/<tool>-<topic>.md` — one file per correction, not
 * merged into a single per-tool doc (that would need safe section-level
 * merging into whatever a human already wrote by hand there, e.g.
 * `curated/standards/jira-cli.md`, deliberately out of scope here).
 * Frontmatter is still `type: inferred, source: agent` (same provenance
 * shape as `writeInferredNote` — probabilistic, consolidation-derived, not
 * human-authored) even though the file lives under `curated/`: the path
 * controls read visibility (everyone sees `curated/`, only the person their
 * own area), not authorship.
 */
export async function writeToolCorrectionNote(
  vaultPath: string,
  tool: string,
  topic: string,
  fields: { confidence: "low" | "medium" | "high"; derived_from: string[]; last_reviewed: string | null },
  body: string,
  condition: WriteCondition = {},
): Promise<boolean> {
  assertNoPathSeparator("tool", tool);
  assertNoPathSeparator("topic", topic);
  const frontmatter = InferredFrontmatterSchema.parse({ type: "inferred", source: "agent", ...fields });
  const standardsRoot = resolve(vaultPath, "curated", "standards");
  const fullPath = resolveWithinRoot(standardsRoot, `${tool}-${topic}.md`);
  return writeNoteFile(vaultPath, fullPath, frontmatter, body, `inferred: standards/${tool}-${topic}`, condition);
}

/**
 * Writes (or overwrites) the deterministic lifecycle record for one
 * confirm-required action at `<userArea(key)>/confirmations/<token>.md`, the
 * area of the person who staged it (see `ConfirmationFrontmatterSchema`'s own
 * doc comment for why the model can't browse it). Called twice per action: once
 * at staging (`status: "pending"`, `resolvedAt: null`), once at resolution
 * (`"confirmed"`/`"failed"`, `resolvedAt` set) — the whole-file replace
 * every writer here already does, not a partial update.
 */
export async function writeConfirmationNote(
  vaultPath: string,
  key: string,
  token: string,
  fields: { status: "pending" | "confirmed" | "failed"; requestedAt: string; resolvedAt: string | null; command: string },
): Promise<void> {
  assertNoPathSeparator("token", token);
  const frontmatter = ConfirmationFrontmatterSchema.parse({
    type: "confirmation",
    status: fields.status,
    requested_at: fields.requestedAt,
    resolved_at: fields.resolvedAt,
    command: fields.command,
  });
  const confirmationsRoot = resolve(vaultPath, userArea(key), "confirmations");
  const fullPath = resolveWithinRoot(confirmationsRoot, `${token}.md`);
  await writeNoteFile(vaultPath, fullPath, frontmatter, "", `confirmation: ${key}/${token} (${fields.status})`);
}

/** Writes a raw/ inbox entry verbatim at `raw/<relativePath>` — no
 * frontmatter, content is whatever a human pasted as-is (see
 * `vault-cli.ts`'s `write-raw`). Never called during a normal
 * conversation; only the self-review job (`self-review-tools.ts`) reads
 * this back to triage it into `curated/`. */
export async function writeRawEntry(vaultPath: string, relativePath: string, body: string): Promise<void> {
  const rawRoot = resolve(vaultPath, "raw");
  const fullPath = resolveWithinRoot(rawRoot, relativePath);
  const content = body.endsWith("\n") ? body : `${body}\n`;
  await writeVerbatimFile(vaultPath, fullPath, content, `raw: ${relativePath}`);
}

/** Rewrites `index.md` at the vault root as `change` turns its current text
 * ("" when it doesn't exist) into, read and written in one unit of the queue.
 * No frontmatter: it's a generated Karpathy-pattern index, not a note. */
export async function updateIndexFile(vaultPath: string, change: (current: string) => string): Promise<void> {
  const fullPath = resolve(vaultPath, "index.md");
  await serializeCommit(async () => {
    const next = change((await readCurrent(fullPath)) ?? "");
    await replaceFile(fullPath, next.endsWith("\n") ? next : `${next}\n`);
    await commitFile(vaultPath, fullPath, "index: update");
  });
}

/** Deletes a raw/ entry once self-review has resolved it (merged,
 * promoted, or discarded). */
export async function deleteRawEntry(vaultPath: string, relativePath: string): Promise<void> {
  const rawRoot = resolve(vaultPath, "raw");
  const fullPath = resolveWithinRoot(rawRoot, relativePath);
  await deleteVaultFile(vaultPath, fullPath, `raw: delete ${relativePath}`);
}

/** Deletes a curated/ doc — used only by the self-review job to retire a
 * redundant/superseded doc (never during a normal conversation). Callers
 * should also remove the doc's `index.md` line in the same pass, so a
 * deletion doesn't leave a dangling index reference. */
export async function deleteCuratedEntry(
  vaultPath: string,
  relativePath: string,
  condition: WriteCondition = {},
): Promise<boolean> {
  const curatedRoot = resolve(vaultPath, "curated");
  const fullPath = resolveWithinRoot(curatedRoot, relativePath);
  return deleteVaultFile(vaultPath, fullPath, `curated: delete ${relativePath}`, condition);
}
