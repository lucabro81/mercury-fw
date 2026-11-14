/**
 * What the dreaming pass keeps between nights (`dreaming.json` in the
 * plugin's data folder): for each note, a hash of the text it counted for, the
 * distinct sessions for and against that text, and the turns behind them. A
 * changed text starts the count over, whoever changed it; so does a person's
 * decision on it (`since`, its `validated_at`).
 *
 * `decide` turns the counts into a status: `contested` at k sessions against;
 * `verified` at k sessions for and none against; nothing otherwise. A note a
 * person validated is never made `verified` by counting, only `contested`
 * again, by k sessions after their decision.
 */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NoteStatus } from "./frontmatter-schema.ts";

/** One note's counts: sessions for and against its text (`hash`), and the turns they come from. */
export type NoteTally = { hash: string; for: string[]; against: string[]; evidence: string[] };

export type DreamingState = { lastPass?: string; notes: Record<string, NoteTally> };

/** What one use of a note says of it. */
export type Verdict = { sessionKey: string; turnId: string; at: string; verdict: "for" | "against" };

const STATE = "dreaming.json";

/** A short hash of a note's body, to tell when its text changed. */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** `state` with `verdicts` added to the counts of `note` (started over when its text isn't `hash` any more), counting only those after `since`. */
export function tally(state: DreamingState, note: string, hash: string, verdicts: Verdict[], since?: string): DreamingState {
  const current = state.notes[note];
  const base: NoteTally = current !== undefined && current.hash === hash ? current : { hash, for: [], against: [], evidence: [] };
  const counted = verdicts.filter((v) => since === undefined || v.at > since);
  const add = (list: string[], items: string[]) => [...new Set([...list, ...items])];
  const next: NoteTally = {
    hash,
    for: add(base.for, counted.filter((v) => v.verdict === "for").map((v) => v.sessionKey)),
    against: add(base.against, counted.filter((v) => v.verdict === "against").map((v) => v.sessionKey)),
    evidence: add(base.evidence, counted.map((v) => v.turnId)),
  };
  return { ...state, notes: { ...state.notes, [note]: next } };
}

/** The status `counts` call for, given the note's `status` now; `undefined` when it stays as it is. */
export function decide(counts: NoteTally, k: number, status: NoteStatus | undefined): NoteStatus | undefined {
  if (counts.against.length >= k) return status === "contested" ? undefined : "contested";
  if (status === "validated" || status === "verified") return undefined;
  if (counts.for.length >= k && counts.against.length === 0) return "verified";
  return undefined;
}

/** The state kept in `dataDir`; empty before the first pass. */
export async function loadState(dataDir: string): Promise<DreamingState> {
  try {
    return JSON.parse(await readFile(join(dataDir, STATE), "utf-8")) as DreamingState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { notes: {} };
    throw err;
  }
}

/** Keeps `state` in `dataDir`, through a temporary file and a rename. */
export async function saveState(dataDir: string, state: DreamingState): Promise<void> {
  const temporary = join(dataDir, `${STATE}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(state), "utf-8");
  await rename(temporary, join(dataDir, STATE));
}
