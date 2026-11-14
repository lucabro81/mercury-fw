/**
 * The notes each turn used, for the dreaming pass: a note is used when the
 * model read it with `read_file` and the read worked. Only curated notes and
 * the person's own notes count (`personal/notes/`, kept by its vault path
 * `users/<key>/notes/`): those are the ones the pass checks.
 *
 * For a learned standard (`curated/standards/<tool>-<topic>.md`) a use also
 * says how the turn went with that tool afterwards: `for` when one of the
 * later CLI calls whose command runs the tool worked, `against` when every
 * one of them failed, nothing when it wasn't called. The tool is a command's
 * binary, its first word, matched against the start of the file name, so a
 * tool with a dash in its name (`atlassian-admin`) is found as it is.
 *
 * Uses are lines of `uses.jsonl` in the plugin's data folder. A pass takes
 * them (`takeUses`, which moves them aside, so a use recorded meanwhile waits
 * for the next pass) and drops them once it's done (`finishUses`); a pass that
 * didn't finish hands them over again the next time.
 */
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnRecord } from "@mercury-fw/plugin-types";
import { userArea } from "./user-area.ts";

/** One note used in one turn. */
export type NoteUse = {
  note: string;
  turnId: string;
  sessionKey: string;
  /** The person's key. */
  person: string;
  /** When the turn ended. */
  at: string;
  outcome?: "for" | "against";
};

const NOTE_RE = /^(curated\/.+|personal\/notes\/.+)\.md$/;
const STANDARD_PREFIX = "curated/standards/";

/** The command's binary, its first word, or `undefined` for a call that isn't a CLI's. */
function binaryOf(input: unknown): string | undefined {
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return undefined;
  return command.trim().split(/\s+/)[0] || undefined;
}

/** The notes `record` used (see the module comment); none for the operator's turns, a confirmation or a turn with no answer. */
export function usesOf(record: TurnRecord): NoteUse[] {
  if (record.kind !== "turn" || record.operator || record.answer === undefined) return [];
  const calls = record.answer.calls ?? [];
  const seen = new Set<string>();
  const uses: NoteUse[] = [];
  calls.forEach((call, index) => {
    if (call.toolName !== "read_file" || !call.result.ok) return;
    const path = (call.input as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || !NOTE_RE.test(path) || path.includes("..")) return;
    const note = path.startsWith("personal/") ? `${userArea(record.person.key)}/${path.slice("personal/".length)}` : path;
    if (seen.has(note)) return;
    seen.add(note);
    const use: NoteUse = { note, turnId: record.turnId, sessionKey: record.sessionKey, person: record.person.key, at: record.endedAt };
    if (note.startsWith(STANDARD_PREFIX)) {
      const file = note.slice(STANDARD_PREFIX.length);
      const later = calls.slice(index + 1).filter((c) => {
        const binary = binaryOf(c.input);
        return binary !== undefined && file.startsWith(`${binary}-`);
      });
      if (later.length > 0) use.outcome = later.some((c) => c.result.ok) ? "for" : "against";
    }
    uses.push(use);
  });
  return uses;
}

const USES = "uses.jsonl";
const TAKING = "uses.taking.jsonl";
const TAKEN = "uses.taken.jsonl";

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Adds `uses` to the ones waiting for the next pass. */
export async function appendUses(dataDir: string, uses: NoteUse[]): Promise<void> {
  if (uses.length === 0) return;
  await appendFile(join(dataDir, USES), uses.map((u) => `${JSON.stringify(u)}\n`).join(""), "utf-8");
}

/** The uses waiting, a pass's unfinished ones first; moved aside, so what's recorded from now on waits for the next pass. */
export async function takeUses(dataDir: string): Promise<NoteUse[]> {
  try {
    await rename(join(dataDir, USES), join(dataDir, TAKING));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const text = (await readOrEmpty(join(dataDir, TAKEN))) + (await readOrEmpty(join(dataDir, TAKING)));
  await writeFile(join(dataDir, TAKEN), text, "utf-8");
  await rm(join(dataDir, TAKING), { force: true });
  const uses: NoteUse[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const use = JSON.parse(line) as NoteUse;
      if (typeof use.note === "string" && typeof use.sessionKey === "string") uses.push(use);
    } catch {
      // A line cut short (the container stopped mid-write) is no use.
    }
  }
  return uses;
}

/** Drops the uses `takeUses` handed over: the pass that took them is done. */
export async function finishUses(dataDir: string): Promise<void> {
  await rm(join(dataDir, TAKEN), { force: true });
}
