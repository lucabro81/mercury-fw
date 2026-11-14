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
 * An entry's file keeps its fields in the frontmatter, `reason` included,
 * and the proposed text as its body, so neither can be mistaken for the
 * other. Every change is a commit through the vault's queue; deciding an
 * entry changes the note and removes the entry in one commit, the entry last.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeIndexKey, removeIndexEntry } from "./index-entry.ts";
import { changeVaultAndCommit, notePath, parseNote, renderNote, validNoteFrontmatter, withNoteType } from "./wiki-note.ts";

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
  return renderNote(
    { note: entry.note, kind: entry.kind, evidence: entry.evidence, opened_at: entry.opened_at, reason: entry.reason },
    entry.proposed ?? "",
  );
}

function parseEntry(id: string, text: string): ReviewEntry {
  const { frontmatter, body } = parseNote(text);
  const entry: ReviewEntry = {
    id,
    note: String(frontmatter.note),
    kind: frontmatter.kind as ReviewKind,
    evidence: Array.isArray(frontmatter.evidence) ? frontmatter.evidence.map(String) : [],
    opened_at: String(frontmatter.opened_at),
    reason: String(frontmatter.reason ?? ""),
  };
  if (body !== "") entry.proposed = body;
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
  if (entry.proposed !== undefined && entry.proposed.trim() === "") throw new Error("a review entry's proposed text can't be empty");
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
    if (current === null) {
      await rm(file);
      outcome = { note: entry.note, outcome: "note-gone" };
      return;
    }
    // Everything is decided and checked before a file changes, and the entry goes last: a decision that
    // throws leaves both as they were, never an entry deleted with its note untouched.
    const note = parseNote(current);
    const frontmatter = withNoteType(entry.note, note.frontmatter);
    const validated = { ...frontmatter, status: "validated", validated_at: now };
    if (entry.kind === "standard" && decision === "accept") {
      await rm(noteFile);
      const index = await readText(resolve(vaultPath, "index.md"));
      if (index !== null) await writeFile(resolve(vaultPath, "index.md"), removeIndexEntry(index, normalizeIndexKey(entry.note)), "utf-8");
      outcome = { note: entry.note, outcome: "deleted" };
    } else if (decision === "accept" && entry.proposed !== undefined) {
      const next = renderNote(validNoteFrontmatter(entry.kind === "locked" ? frontmatter : validated), entry.proposed);
      await writeFile(noteFile, next, "utf-8");
      outcome = { note: entry.note, outcome: "rewritten" };
    } else {
      if (entry.kind !== "locked") await writeFile(noteFile, renderNote(validNoteFrontmatter(validated), note.body), "utf-8");
      outcome = { note: entry.note, outcome: "kept" };
    }
    await rm(file);
  });
  return outcome!;
}
