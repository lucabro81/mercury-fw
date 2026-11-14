/**
 * The dreaming pass, the last of the wiki's nightly run when the instance
 * turns it on (`wiki({ review: { dreaming } })`): each note used since the
 * last pass is checked against the conversations it was used in, and each
 * curated document the review wrote (`author: mercury-review`) that has no
 * status yet is checked once, even unused. Locked notes, and notes contested
 * and waiting for a person, are left alone.
 *
 * - A learned standard (`curated/standards/`) is decided by counting, never
 *   by the model: the sessions where its tool then worked or failed
 *   (`dreaming-uses.ts`, `dreaming-state.ts`). Contested, it gets a `standard`
 *   review entry.
 * - A person's note is judged by the model on that person's turns that read
 *   it, and rewritten when one contradicts it. No review: it's theirs.
 * - Any other curated note is judged by the model on everyone's turns that
 *   read it and on what it knows of the world (only to contest, never about
 *   the team's own matters). Contested, it gets a `curated` review entry
 *   with the text proposed in its place.
 *
 * Each note is a job of its own on the core's queue, at idle urgency. A note
 * that fails is logged, its uses kept for the next pass, and the others go on.
 */
import type { ConversationStore, JobUrgency, StoredMessage } from "@mercury-fw/plugin-types";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { bodyHash, decide, loadState, saveState, tally, type DreamingState, type Verdict } from "./dreaming-state.ts";
import { appendUses, finishUses, takeUses, type NoteUse } from "./dreaming-uses.ts";
import type { NoteStatus } from "./frontmatter-schema.ts";
import { createLockCheck } from "./locks.ts";
import { openReview } from "./review-entries.ts";
import { REVIEW_AUTHOR } from "./self-review-tools.ts";
import { listWikiFilesInRoots } from "./wiki-read.ts";
import { readNote, rewriteNoteBody, updateNoteFrontmatter, withoutLeadingFrontmatter, type NoteFile } from "./wiki-note.ts";
import { resolve } from "node:path";

/** A turn that read the note, as the model is shown it: its messages and the ones right after. */
export type Excerpt = { turnId: string; messages: Array<{ role: "user" | "assistant"; content: string }> };

/** What the model is asked about one note. */
export type JudgeRequest = { kind: "personal" | "curated"; note: string; body: string; excerpts: Excerpt[] };

/** What the model answers: the turns that contradict the note, whether it's plainly wrong, why, and the text it would put in its place. */
export type Judgment = { contradictedBy: string[]; obviouslyWrong: boolean; reason: string; correctedText: string };

export type Judge = (request: JudgeRequest) => Promise<Judgment>;

export type DreamingDeps = {
  vaultPath: string;
  /** The plugin's data folder, where the uses and the counts are kept. */
  dataDir: string;
  /** How many distinct sessions decide a status. */
  k: number;
  /** The instance's locked paths. */
  locked: readonly string[];
  conversations: ConversationStore;
  judge: Judge;
  job: <T>(name: string, urgency: JobUrgency, fn: () => Promise<T>) => Promise<T>;
  log: (msg: string) => void;
  now?: () => string;
};

const STANDARDS = "curated/standards/";
/** How many messages after the turn that read a note the model is shown. */
const FOLLOWING = 4;
/** How many pages of a conversation are looked through for a turn. */
const MAX_PAGES = 20;
const PAGE = 100;
/** How much of a message the model is shown. */
const MESSAGE_MAX = 2000;

/** The messages of the turn `turnId` and the few after it, from the person's conversation `sessionKey`. */
async function excerptOf(store: ConversationStore, use: NoteUse): Promise<Excerpt> {
  const kept: StoredMessage[] = [];
  let cursor: string | undefined;
  let found = false;
  let following = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { messages, next } = await store.messages({ userId: use.person, sessionKey: use.sessionKey, order: "asc", limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const message of messages) {
      if (message.turnId === use.turnId) {
        kept.push(message);
        found = true;
      } else if (found && following < FOLLOWING) {
        kept.push(message);
        following += 1;
      }
    }
    if ((found && following >= FOLLOWING) || next === undefined) break;
    cursor = next;
  }
  return {
    turnId: use.turnId,
    messages: kept.map((m) => ({ role: m.role, content: m.content.length > MESSAGE_MAX ? `${m.content.slice(0, MESSAGE_MAX)}…` : m.content })),
  };
}

/** The curated documents the review wrote that have no status yet. */
async function newFromReview(vaultPath: string): Promise<string[]> {
  const found: string[] = [];
  for (const path of await listWikiFilesInRoots(vaultPath, [resolve(vaultPath, "curated")])) {
    const note = await readNote(vaultPath, path).catch(() => null);
    if (note?.frontmatter.type === "curated" && note.frontmatter.author === REVIEW_AUTHOR && note.frontmatter.status === undefined) found.push(path);
  }
  return found;
}

/** Runs one dreaming pass (see the module comment). */
export async function runDreaming(deps: DreamingDeps): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  const isLocked = createLockCheck(deps.vaultPath, deps.locked);
  let state: DreamingState = await loadState(deps.dataDir);
  const uses = await takeUses(deps.dataDir);
  const byNote = new Map<string, NoteUse[]>();
  for (const use of uses) byNote.set(use.note, [...(byNote.get(use.note) ?? []), use]);
  const notes = [...new Set([...byNote.keys(), ...(await newFromReview(deps.vaultPath))])].sort();
  const failed: NoteUse[] = [];

  const setStatus = (note: string, status: NoteStatus, evidence: string[]) =>
    updateNoteFrontmatter(deps.vaultPath, note, (fm) => ({ ...fm, status, verified_at: now(), evidence }), `dreaming: ${status} ${note}`);

  async function check(note: string, noteUses: NoteUse[]): Promise<void> {
    if (await isLocked(note)) return;
    const current = await readNote(deps.vaultPath, note);
    if (current === null) return;
    const status = current.frontmatter.status as NoteStatus | undefined;
    if (status === "contested") return;
    const hash = bodyHash(current.body);
    const since = status === "validated" ? String(current.frontmatter.validated_at ?? "") || undefined : undefined;

    if (note.startsWith(STANDARDS) && current.frontmatter.type === "inferred") {
      const verdicts: Verdict[] = noteUses.flatMap((u) => (u.outcome === undefined ? [] : [{ sessionKey: u.sessionKey, turnId: u.turnId, at: u.at, verdict: u.outcome }]));
      state = tally(state, note, hash, verdicts, since);
      const counts = state.notes[note]!;
      const next = decide(counts, deps.k, status);
      if (next === undefined) return;
      await setStatus(note, next, counts.evidence);
      if (next === "contested") {
        await openReview(deps.vaultPath, {
          note,
          kind: "standard",
          evidence: counts.evidence,
          opened_at: now(),
          reason: `The tool failed after this standard was read, in ${counts.against.length} conversations.`,
        });
      }
      return;
    }

    const personal = note.startsWith("users/");
    if (personal && noteUses.length === 0) return;
    const excerpts = await Promise.all(noteUses.map((u) => excerptOf(deps.conversations, u)));
    const judged = await deps.judge({ kind: personal ? "personal" : "curated", note, body: current.body, excerpts });
    // A frontmatter the model copied at the top of its text isn't part of the note's body.
    const judgment = { ...judged, correctedText: withoutLeadingFrontmatter(judged.correctedText.trim()) };
    const against = new Set(judgment.contradictedBy);
    const verdicts: Verdict[] = noteUses.map((u) => ({ sessionKey: u.sessionKey, turnId: u.turnId, at: u.at, verdict: against.has(u.turnId) ? "against" : "for" }));

    if (personal) {
      if (against.size > 0 && judgment.correctedText.trim() !== "") {
        await rewriteNoteBody(deps.vaultPath, note, current as NoteFile, judgment.correctedText.trim(), (fm) => ({
          ...fm,
          status: "verified",
          verified_at: now(),
          evidence: [...against],
        }), `dreaming: rewrite ${note}`);
        const { [note]: _dropped, ...rest } = state.notes;
        state = { ...state, notes: rest };
        return;
      }
      state = tally(state, note, hash, verdicts, since);
      const next = decide(state.notes[note]!, deps.k, status);
      if (next === "verified") await setStatus(note, next, state.notes[note]!.evidence);
      return;
    }

    const contest = async (evidence: string[]) => {
      await setStatus(note, "contested", evidence);
      const proposed = judgment.correctedText.trim();
      await openReview(deps.vaultPath, {
        note,
        kind: "curated",
        evidence,
        opened_at: now(),
        reason: judgment.reason.trim() || "The note looks wrong.",
        ...(proposed === "" ? {} : { proposed }),
      });
    };
    if (status !== "validated" && (against.size > 0 || judgment.obviouslyWrong)) {
      await contest([...against]);
      return;
    }
    state = tally(state, note, hash, verdicts, since);
    const counts = state.notes[note]!;
    const next = decide(counts, deps.k, status);
    if (next === "contested") await contest(counts.evidence);
    else if (next === "verified") await setStatus(note, next, counts.evidence);
    else if (status === undefined && current.frontmatter.author === REVIEW_AUTHOR) await setStatus(note, "unverified", []);
  }

  for (const note of notes) {
    const noteUses = byNote.get(note) ?? [];
    try {
      await deps.job("dreaming", "idle", () => check(note, noteUses));
    } catch (err) {
      deps.log(`dreaming: ${note} not checked: ${String(err)}`);
      failed.push(...noteUses);
    }
    await saveState(deps.dataDir, state);
  }
  state = { ...state, lastPass: now() };
  await saveState(deps.dataDir, state);
  // The failed notes' uses go back before the handled ones are dropped: a stop in between repeats some, loses none.
  await appendUses(deps.dataDir, failed);
  await finishUses(deps.dataDir);
}

const JudgmentSchema = z.object({
  contradicted_by: z.array(z.string()),
  obviously_wrong: z.boolean(),
  reason: z.string(),
  corrected_text: z.string(),
});

type GenerateObjectFn = (params: { model: LanguageModel; schema: typeof JudgmentSchema; instructions: string; prompt: string }) => Promise<{
  object: z.infer<typeof JudgmentSchema>;
}>;

const SHARED =
  "Each turn below read the note while answering. Look at what the person said in it and right after: a correction, " +
  "a fact that contradicts the note, a step that didn't work as the note says. List in contradicted_by the ids of the " +
  "turns that show the note is wrong or out of date, and only those; an empty list when none does. Never quote the " +
  "conversations: reason is one sentence of your own on what is wrong, without names or anything a person said word for word.";

const PERSONAL_SYSTEM =
  "You check a note the assistant keeps for one person, against that person's own conversations. " +
  SHARED +
  " When a turn contradicts the note, write in corrected_text the whole note as it should read now, keeping everything " +
  "that is still right; otherwise leave it empty. obviously_wrong is always false here.";

const CURATED_SYSTEM =
  "You check a document of the team's shared wiki against the conversations that used it. " +
  SHARED +
  " Set obviously_wrong to true only when the document states something plainly false about the world in general, " +
  "never about this team's own conventions, projects, people or tools, which you can't know. When you list a turn or " +
  "set obviously_wrong, write in corrected_text the whole document as you would have it read; otherwise leave it empty.";

/** The model's judgment on a note, through `generateObject` (structured output). */
export function createDreamingJudge(
  model: LanguageModel,
  generateObjectFn: GenerateObjectFn = generateObject as unknown as GenerateObjectFn,
): Judge {
  return async (request) => {
    const turns =
      request.excerpts.length === 0
        ? "No conversation used it yet."
        : request.excerpts.map((e) => [`Turn ${e.turnId}:`, ...e.messages.map((m) => `${m.role}: ${m.content}`)].join("\n")).join("\n\n");
    const { object } = await generateObjectFn({
      model,
      schema: JudgmentSchema,
      instructions: request.kind === "personal" ? PERSONAL_SYSTEM : CURATED_SYSTEM,
      prompt: `Note (${request.note}):\n${request.body}\n\n${turns}`,
    });
    const shown = new Set(request.excerpts.map((e) => e.turnId));
    return {
      contradictedBy: object.contradicted_by.filter((id) => shown.has(id)),
      obviouslyWrong: request.kind === "curated" && object.obviously_wrong,
      reason: object.reason,
      correctedText: object.corrected_text,
    };
  };
}
