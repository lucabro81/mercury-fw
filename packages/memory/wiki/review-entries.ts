/**
 * The vault's `review/` folder: what a person has to decide on, one entry per
 * curated note (`review/<id>.md`, the id from the note's path). The nightly
 * passes open entries: the dreaming pass on a note it contests, the review on
 * a locked note it would have changed. `mfw vault review` lists and decides
 * them. The folder is outside `curated/` and the people's areas, so the model
 * never reads it, and outside `raw/`, so the triage never takes it.
 *
 * An entry's kind says what deciding it does:
 *
 * | kind       | accept                                   | reject                     |
 * |------------|------------------------------------------|----------------------------|
 * | `curated`  | the proposed text, `status: validated`   | the text kept, `validated` |
 * | `standard` | the standard deleted, with its index line | `status: validated`        |
 * | `locked`   | the proposed text, still locked          | nothing changes            |
 *
 * Every change is a commit through the vault's queue; deciding an entry
 * changes the note and removes the entry in one commit.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeIndexKey, removeIndexEntry } from "./index-entry.ts";
import { changeVaultAndCommit, notePath, parseNote, renderNote, validNoteFrontmatter } from "./wiki-note.ts";

/** What deciding an entry does to its note (see the module comment). */
export type ReviewKind = "curated" | "standard" | "locked";

/**
 * One entry: the note (vault path, `curated/…`), its kind, the turns behind it
 * (`evidence`), when it was opened, why in a sentence (`reason`), and the text
 * proposed in the note's place, when there is one.
 */
export type ReviewEntry = {
  id: string;
  note: string;
  kind: ReviewKind;
  evidence: string[];
  opened_at: string;
  reason: string;
  proposed?: string;
};

/** What `decideReview` did to the note. */
export type ReviewOutcome = { note: string; outcome: "rewritten" | "kept" | "deleted" | "note-gone" };

const PROPOSED_HEADING = "\n\n## Proposed\n\n";
const ID_RE = /^[^/\\.][^/\\]*$/;

/** The id of the entry on the note at `note`: its path without `.md`, folders joined by `--`. */
export function reviewId(note: string): string {
  return note.replace(/\.md$/, "").split("/").join("--");
}

function reviewFile(vaultPath: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`not a review id: ${id}`);
  return resolve(vaultPath, "review", `${id}.md`);
}

function renderEntry(entry: Omit<ReviewEntry, "id">): string {
  const body = entry.proposed === undefined ? entry.reason : `${entry.reason}${PROPOSED_HEADING}${entry.proposed}`;
  return renderNote({ note: entry.note, kind: entry.kind, evidence: entry.evidence, opened_at: entry.opened_at }, body);
}

function parseEntry(id: string, text: string): ReviewEntry {
  const { frontmatter, body } = parseNote(text);
  const at = body.indexOf(PROPOSED_HEADING);
  const entry: ReviewEntry = {
    id,
    note: String(frontmatter.note),
    kind: frontmatter.kind as ReviewKind,
    evidence: Array.isArray(frontmatter.evidence) ? frontmatter.evidence.map(String) : [],
    opened_at: String(frontmatter.opened_at),
    reason: at < 0 ? body : body.slice(0, at),
  };
  if (at >= 0) entry.proposed = body.slice(at + PROPOSED_HEADING.length);
  return entry;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Opens an entry on `entry.note`, replacing the one already open on it; resolves its id. */
export async function openReview(vaultPath: string, entry: Omit<ReviewEntry, "id">): Promise<string> {
  if (!entry.note.startsWith("curated/")) throw new Error(`a review entry is for a curated note: ${entry.note}`);
  notePath(vaultPath, entry.note);
  const id = reviewId(entry.note);
  await changeVaultAndCommit(vaultPath, `review: open ${id}`, async () => {
    await mkdir(resolve(vaultPath, "review"), { recursive: true });
    await writeFile(reviewFile(vaultPath, id), renderEntry(entry), "utf-8");
  });
  return id;
}

/** The entry `id`, or `null` when there's none. */
export async function readReview(vaultPath: string, id: string): Promise<ReviewEntry | null> {
  const text = await readText(reviewFile(vaultPath, id));
  return text === null ? null : parseEntry(id, text);
}

/** Every open entry, by id. */
export async function listReviews(vaultPath: string): Promise<ReviewEntry[]> {
  let files: string[];
  try {
    files = await readdir(resolve(vaultPath, "review"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: ReviewEntry[] = [];
  for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
    const id = file.slice(0, -".md".length);
    const entry = await readReview(vaultPath, id);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** Removes the entry `id` without touching its note. */
export async function closeReview(vaultPath: string, id: string): Promise<void> {
  const file = reviewFile(vaultPath, id);
  await changeVaultAndCommit(vaultPath, `review: close ${id}`, () => rm(file, { force: true }));
}

/**
 * Decides the entry `id` as the module comment's table says, `now` as the
 * note's `validated_at`, and removes it, in one commit. Throws when there's no
 * such entry.
 */
export async function decideReview(vaultPath: string, id: string, decision: "accept" | "reject", now: string): Promise<ReviewOutcome> {
  const file = reviewFile(vaultPath, id);
  let outcome: ReviewOutcome | undefined;
  await changeVaultAndCommit(vaultPath, `review: ${decision} ${id}`, async () => {
    const text = await readText(file);
    if (text === null) throw new Error(`no review entry ${id}`);
    const entry = parseEntry(id, text);
    const noteFile = notePath(vaultPath, entry.note);
    const current = await readText(noteFile);
    await rm(file);
    if (current === null) {
      outcome = { note: entry.note, outcome: "note-gone" };
      return;
    }
    const note = parseNote(current);
    const validated = { ...note.frontmatter, status: "validated", validated_at: now };
    const write = async (frontmatter: Record<string, unknown>, body: string) =>
      writeFile(noteFile, renderNote(validNoteFrontmatter(frontmatter), body), "utf-8");

    if (entry.kind === "standard" && decision === "accept") {
      await rm(noteFile);
      const index = await readText(resolve(vaultPath, "index.md"));
      if (index !== null) await writeFile(resolve(vaultPath, "index.md"), removeIndexEntry(index, normalizeIndexKey(entry.note)), "utf-8");
      outcome = { note: entry.note, outcome: "deleted" };
    } else if (decision === "accept" && entry.proposed !== undefined) {
      await write(entry.kind === "locked" ? note.frontmatter : validated, entry.proposed);
      outcome = { note: entry.note, outcome: "rewritten" };
    } else {
      if (entry.kind !== "locked") await write(validated, note.body);
      outcome = { note: entry.note, outcome: "kept" };
    }
  });
  return outcome!;
}
