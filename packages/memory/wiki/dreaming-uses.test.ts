/**
 * Which notes a turn used, as the dreaming pass counts them: every read_file
 * that worked on a curated note or one of the person's notes, recorded from
 * the turn's record, kept in the plugin's data folder until the next pass.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallRecord, TurnRecord } from "@mercury-fw/plugin-types";
import { appendUses, finishUses, takeUses, usesOf, type NoteUse } from "./dreaming-uses.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-dreaming-uses-"));
  dirs.push(dir);
  return dir;
}

const read = (path: string, ok = true): CallRecord => ({ toolName: "read_file", input: { path }, result: { ok, ran: JSON.stringify({ path }) } });
const cli = (command: string, ok: boolean): CallRecord => ({ toolName: "jiraCommand", input: { command }, result: { ok, ran: command } });

function turn(calls: CallRecord[], over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    kind: "turn",
    sessionKey: "s1",
    person: { key: "static:alice" },
    operator: false,
    as: "anyone",
    turnId: "t1",
    multiUser: false,
    outcome: "done",
    origin: "person",
    input: "?",
    startedAt: "2026-11-14T10:00:00.000Z",
    endedAt: "2026-11-14T10:00:05.000Z",
    answer: { content: "ok", calls },
    ...over,
  } as TurnRecord;
}

const base = { turnId: "t1", sessionKey: "s1", person: "static:alice", at: "2026-11-14T10:00:05.000Z" };

describe("usesOf", () => {
  it("records each curated note and each of the person's notes read, by its vault path", () => {
    expect(usesOf(turn([read("curated/release.md"), read("personal/notes/plan.md")]))).toEqual([
      { ...base, note: "curated/release.md" },
      { ...base, note: "users/static%3Aalice/notes/plan.md" },
    ]);
  });

  it("leaves out a read that failed, a person's inferred notes, and paths that aren't notes", () => {
    expect(
      usesOf(turn([read("curated/release.md", false), read("personal/inferred/team.md"), read("raw/x.md"), read("curated/x.txt")])),
    ).toEqual([]);
  });

  it("records a note read twice in one turn once", () => {
    expect(usesOf(turn([read("curated/release.md"), read("curated/release.md")]))).toEqual([{ ...base, note: "curated/release.md" }]);
  });

  it("leaves out the operator's turns, a confirmation, and a turn with no answer", () => {
    expect(usesOf(turn([read("curated/release.md")], { operator: true }))).toEqual([]);
    expect(usesOf(turn([read("curated/release.md")], { answer: undefined, outcome: "failed" }))).toEqual([]);
    const confirmation = { kind: "confirmation", sessionKey: "s1", person: { key: "static:alice" }, operator: false, as: "anyone", content: "", confirmation: { id: "x", status: "ok" }, at: "2026-11-14T10:00:00.000Z" } as TurnRecord;
    expect(usesOf(confirmation)).toEqual([]);
  });

  describe("a standard's outcome, from the later calls of the same turn to its tool", () => {
    it("is for when one of them worked", () => {
      const uses = usesOf(turn([read("curated/standards/jira-fields.md"), cli("jira issue list", false), cli("jira issue list --fields key", true)]));
      expect(uses).toEqual([{ ...base, note: "curated/standards/jira-fields.md", outcome: "for" }]);
    });

    it("is against when every one of them failed", () => {
      const uses = usesOf(turn([read("curated/standards/jira-fields.md"), cli("jira issue list", false), cli("  jira   issue list -x", false)]));
      expect(uses).toEqual([{ ...base, note: "curated/standards/jira-fields.md", outcome: "against" }]);
    });

    it("is none when the tool wasn't called after it, before it or another tool doesn't count", () => {
      const uses = usesOf(turn([cli("jira issue list", false), read("curated/standards/jira-fields.md"), cli("bitbucket pr list", false)]));
      expect(uses).toEqual([{ ...base, note: "curated/standards/jira-fields.md" }]);
    });

    it("matches a tool whose name has a dash by the command's binary, not by cutting the file name", () => {
      const admin = (command: string, ok: boolean): CallRecord => ({ toolName: "adminCommand", input: { command }, result: { ok, ran: command } });
      const uses = usesOf(turn([read("curated/standards/atlassian-admin-users.md"), admin("atlassian-admin users list", false)]));
      expect(uses).toEqual([{ ...base, note: "curated/standards/atlassian-admin-users.md", outcome: "against" }]);
    });
  });
});

describe("appendUses, takeUses, finishUses", () => {
  const use = (note: string): NoteUse => ({ ...base, note });

  it("keep the uses across calls, hand over those up to now, and drop them once the pass is done", async () => {
    const dir = await dataDir();
    await appendUses(dir, [use("curated/a.md")]);
    await appendUses(dir, [use("curated/b.md")]);

    const taken = await takeUses(dir);
    expect(taken).toEqual([use("curated/a.md"), use("curated/b.md")]);

    // A use recorded while the pass runs waits for the next one.
    await appendUses(dir, [use("curated/c.md")]);
    await finishUses(dir);
    expect(await takeUses(dir)).toEqual([use("curated/c.md")]);
  });

  it("hand over again the uses of a pass that didn't finish, with the new ones", async () => {
    const dir = await dataDir();
    await appendUses(dir, [use("curated/a.md")]);
    await takeUses(dir);
    await appendUses(dir, [use("curated/b.md")]);

    expect(await takeUses(dir)).toEqual([use("curated/a.md"), use("curated/b.md")]);
  });

  it("are empty with nothing recorded, and skip a line that isn't a use", async () => {
    const dir = await dataDir();
    expect(await takeUses(dir)).toEqual([]);
    await appendUses(dir, [use("curated/a.md")]);
    await Bun.write(join(dir, "uses.jsonl"), `${await readFile(join(dir, "uses.jsonl"), "utf-8")}not json\n`);
    expect(await takeUses(dir)).toEqual([use("curated/a.md")]);
  });
});
