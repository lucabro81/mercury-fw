/**
 * The dreaming pass: each note used since the last pass (and each one the
 * nightly review just wrote) checked against the conversations it was used
 * in, on a real vault, an in-memory conversation store and a stand-in for
 * the model's judgment.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationStore, StoredMessage } from "@mercury-fw/plugin-types";
import { appendUses, takeUses, type NoteUse } from "./dreaming-uses.ts";
import { createDreamingJudge, runDreaming, type Judge, type JudgeRequest, type Judgment } from "./dreaming.ts";
import { listReviews } from "./review-entries.ts";
import { initVault } from "./vault-init.ts";
import { readNote, writeCuratedNote, writePersonalNote, writeToolCorrectionNote } from "./wiki-note.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const NOW = "2026-11-15T04:00:00.000Z";
const ALICE = "static:alice";
const BOB = "static:bob";

/** A conversation store holding `messages`, read the way the pass reads it. */
function storeOf(messages: StoredMessage[]): ConversationStore {
  return {
    ready: async () => {},
    append: async () => {},
    messages: async ({ userId, sessionKey, order, limit, cursor }) => {
      const all = messages.filter((m) => m.userId === userId && m.sessionKey === sessionKey);
      const sorted = order === "asc" ? all : [...all].reverse();
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = sorted.slice(start, start + limit);
      return start + limit < sorted.length ? { messages: page, next: String(start + limit) } : { messages: page };
    },
    recent: async () => [],
    setTitle: async () => {},
    titles: async () => [],
    health: async () => ({ ok: true }),
  };
}

let seq = 0;
function msg(userId: string, sessionKey: string, role: "user" | "assistant", content: string, turnId?: string): StoredMessage {
  seq += 1;
  return { id: `m${seq}`, userId, sessionKey, role, content, timestamp: `2026-11-14T10:${String(seq).padStart(2, "0")}:00.000Z`, ...(turnId ? { turnId } : {}) };
}

function use(note: string, person: string, sessionKey: string, turnId: string, extra: Partial<NoteUse> = {}): NoteUse {
  return { note, person, sessionKey, turnId, at: "2026-11-14T10:00:00.000Z", ...extra };
}

/** A judge answering `answer` for every note, recording what it was asked. */
function judgeOf(answer: (req: JudgeRequest) => Judgment) {
  const asked: JudgeRequest[] = [];
  const judge: Judge = async (req) => (asked.push(req), answer(req));
  return { judge, asked };
}
const keep: Judgment = { contradictedBy: [], obviouslyWrong: false, reason: "", correctedText: "" };

async function setup() {
  const vaultPath = join(await temp("mercury-dreaming-vault-"), "vault");
  await initVault(vaultPath);
  const dataDir = await temp("mercury-dreaming-data-");
  return { vaultPath, dataDir };
}

function deps(base: { vaultPath: string; dataDir: string }, judge: Judge, over: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const jobs: string[] = [];
  return {
    logs,
    jobs,
    deps: {
      ...base,
      k: 3,
      locked: [] as string[],
      conversations: storeOf([]),
      judge,
      job: async <T,>(name: string, urgency: string, fn: () => Promise<T>) => (jobs.push(`${name}:${urgency}`), fn()),
      log: (m: string) => logs.push(m),
      now: () => NOW,
      ...over,
    },
  };
}

describe("runDreaming", () => {
  it("checks only the notes used since the last pass, each as its own idle job, and drops the uses it handled", async () => {
    const base = await setup();
    await writeCuratedNote(base.vaultPath, "used.md", {}, "Used.");
    await writeCuratedNote(base.vaultPath, "unused.md", {}, "Unused.");
    await appendUses(base.dataDir, [use("curated/used.md", ALICE, "s1", "t1")]);
    const { judge, asked } = judgeOf(() => keep);
    const run = deps(base, judge);

    await runDreaming(run.deps);

    expect(asked.map((r) => r.note)).toEqual(["curated/used.md"]);
    expect(run.jobs).toEqual(["dreaming:idle"]);
    expect(await takeUses(base.dataDir)).toEqual([]);
  });

  it("leaves locked notes and notes waiting for a person's decision alone", async () => {
    const base = await setup();
    await writeCuratedNote(base.vaultPath, "policy.md", { locked: true }, "Policy.");
    await writeCuratedNote(base.vaultPath, "synced/page.md", {}, "Synced.");
    await writeCuratedNote(base.vaultPath, "open.md", { status: "contested" }, "Open.");
    await appendUses(base.dataDir, [
      use("curated/policy.md", ALICE, "s1", "t1"),
      use("curated/synced/page.md", ALICE, "s1", "t1"),
      use("curated/open.md", ALICE, "s1", "t1"),
    ]);
    const { judge, asked } = judgeOf(() => keep);

    await runDreaming(deps(base, judge, { locked: ["curated/synced/**"] }).deps);

    expect(asked).toEqual([]);
  });

  describe("a learned standard, decided by counting", () => {
    const standard = "curated/standards/jira-fields.md";
    const write = (vaultPath: string) =>
      writeToolCorrectionNote(vaultPath, "jira", "fields", { confidence: "low", derived_from: ["x"], last_reviewed: null }, "Use --fields.");

    it("is verified at k sessions where the tool then worked, without asking the model", async () => {
      const base = await setup();
      await write(base.vaultPath);
      await appendUses(base.dataDir, ["s1", "s2", "s3"].map((s, i) => use(standard, ALICE, s, `t${i}`, { outcome: "for" })));
      const { judge, asked } = judgeOf(() => keep);

      await runDreaming(deps(base, judge).deps);

      expect(asked).toEqual([]);
      expect((await readNote(base.vaultPath, standard))?.frontmatter).toMatchObject({ status: "verified", verified_at: NOW, evidence: ["t0", "t1", "t2"] });
    });

    it("counts sessions across nights", async () => {
      const base = await setup();
      await write(base.vaultPath);
      const { judge } = judgeOf(() => keep);
      for (const s of ["s1", "s2"]) {
        await appendUses(base.dataDir, [use(standard, ALICE, s, `t-${s}`, { outcome: "for" })]);
        await runDreaming(deps(base, judge).deps);
      }
      expect((await readNote(base.vaultPath, standard))?.frontmatter.status).toBeUndefined();

      await appendUses(base.dataDir, [use(standard, BOB, "s3", "t-s3", { outcome: "for" })]);
      await runDreaming(deps(base, judge).deps);
      expect((await readNote(base.vaultPath, standard))?.frontmatter.status).toBe("verified");
    });

    it("is contested at k sessions where the tool then failed, with a standard entry for a person", async () => {
      const base = await setup();
      await write(base.vaultPath);
      await appendUses(base.dataDir, ["s1", "s2", "s3"].map((s, i) => use(standard, ALICE, s, `t${i}`, { outcome: "against" })));

      await runDreaming(deps(base, judgeOf(() => keep).judge).deps);

      expect((await readNote(base.vaultPath, standard))?.frontmatter.status).toBe("contested");
      expect(await listReviews(base.vaultPath)).toEqual([
        {
          id: "curated--standards--jira-fields",
          note: standard,
          kind: "standard",
          evidence: ["t0", "t1", "t2"],
          opened_at: NOW,
          reason: "The tool failed after this standard was read, in 3 conversations.",
        },
      ]);
    });
  });

  describe("a person's note, checked by the model", () => {
    const note = "users/static%3Aalice/notes/plan.md";

    it("is given that person's turns: the turn that read it and what came right after", async () => {
      const base = await setup();
      await writePersonalNote(base.vaultPath, ALICE, "personal/notes/plan.md", {}, "Standup at 9.");
      const conversations = storeOf([
        msg(ALICE, "s1", "user", "earlier"),
        msg(ALICE, "s1", "user", "when is standup?", "t1"),
        msg(ALICE, "s1", "assistant", "At 9.", "t1"),
        msg(ALICE, "s1", "user", "no, it moved to 10", "t2"),
        msg(ALICE, "s1", "assistant", "Noted.", "t2"),
        msg(BOB, "s1", "user", "bob's own", "t9"),
      ]);
      await appendUses(base.dataDir, [use(note, ALICE, "s1", "t1")]);
      const { judge, asked } = judgeOf(() => keep);

      await runDreaming(deps(base, judge, { conversations }).deps);

      expect(asked).toEqual([
        {
          kind: "personal",
          note,
          body: "Standup at 9.",
          excerpts: [
            {
              turnId: "t1",
              messages: [
                { role: "user", content: "when is standup?" },
                { role: "assistant", content: "At 9." },
                { role: "user", content: "no, it moved to 10" },
                { role: "assistant", content: "Noted." },
              ],
            },
          ],
        },
      ]);
    });

    it("finds the turn past the first page of a long conversation, and what follows it across pages", async () => {
      const base = await setup();
      await writePersonalNote(base.vaultPath, ALICE, "personal/notes/plan.md", {}, "Standup at 9.");
      const earlier = Array.from({ length: 99 }, (_, i) => msg(ALICE, "s1", "user", `earlier ${i}`));
      const conversations = storeOf([
        ...earlier,
        msg(ALICE, "s1", "user", "when is standup?", "t1"),
        msg(ALICE, "s1", "assistant", "At 9.", "t1"),
        ...Array.from({ length: 6 }, (_, i) => msg(ALICE, "s1", "user", `after ${i}`, `t${i + 2}`)),
      ]);
      await appendUses(base.dataDir, [use(note, ALICE, "s1", "t1")]);
      const { judge, asked } = judgeOf(() => keep);

      await runDreaming(deps(base, judge, { conversations }).deps);

      expect(asked[0]?.excerpts[0]?.messages.map((m) => m.content)).toEqual(["when is standup?", "At 9.", "after 0", "after 1", "after 2", "after 3"]);
    });

    it("is rewritten when a turn contradicts it, and marked verified", async () => {
      const base = await setup();
      await writePersonalNote(base.vaultPath, ALICE, "personal/notes/plan.md", {}, "Standup at 9.");
      await appendUses(base.dataDir, [use(note, ALICE, "s1", "t1")]);
      const { judge } = judgeOf(() => ({ contradictedBy: ["t1"], obviouslyWrong: false, reason: "moved", correctedText: "Standup at 10." }));

      await runDreaming(deps(base, judge).deps);

      expect(await readNote(base.vaultPath, note)).toEqual({
        frontmatter: { type: "personal", status: "verified", verified_at: NOW, evidence: ["t1"] },
        body: "Standup at 10.",
      });
      expect(await listReviews(base.vaultPath)).toEqual([]);
    });

    it("is verified once k sessions used it with nothing against", async () => {
      const base = await setup();
      await writePersonalNote(base.vaultPath, ALICE, "personal/notes/plan.md", {}, "Standup at 9.");
      await appendUses(base.dataDir, ["s1", "s2", "s3"].map((s, i) => use(note, ALICE, s, `t${i}`)));

      await runDreaming(deps(base, judgeOf(() => keep).judge).deps);

      expect((await readNote(base.vaultPath, note))?.frontmatter.status).toBe("verified");
    });
  });

  describe("a curated note, checked by the model", () => {
    it("is contested when a turn contradicts it, with a curated entry carrying the proposed text", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "release.md", {}, "Tag first.");
      await appendUses(base.dataDir, [use("curated/release.md", ALICE, "s1", "t1"), use("curated/release.md", BOB, "s2", "t2")]);
      const { judge, asked } = judgeOf(() => ({ contradictedBy: ["t2"], obviouslyWrong: false, reason: "Someone said the order is the other way round.", correctedText: "Merge first, then tag." }));

      await runDreaming(deps(base, judge).deps);

      expect(asked[0]?.kind).toBe("curated");
      expect((await readNote(base.vaultPath, "curated/release.md"))?.frontmatter).toMatchObject({ status: "contested", verified_at: NOW, evidence: ["t2"] });
      expect(await listReviews(base.vaultPath)).toEqual([
        {
          id: "curated--release",
          note: "curated/release.md",
          kind: "curated",
          evidence: ["t2"],
          opened_at: NOW,
          reason: "Someone said the order is the other way round.",
          proposed: "Merge first, then tag.",
        },
      ]);
    });

    it("is contested when the model finds it plainly wrong, even with no turn against it", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "earth.md", {}, "The earth is flat.");
      await appendUses(base.dataDir, [use("curated/earth.md", ALICE, "s1", "t1")]);
      const { judge } = judgeOf(() => ({ contradictedBy: [], obviouslyWrong: true, reason: "The earth isn't flat.", correctedText: "" }));

      await runDreaming(deps(base, judge).deps);

      expect((await readNote(base.vaultPath, "curated/earth.md"))?.frontmatter.status).toBe("contested");
      const [entry] = await listReviews(base.vaultPath);
      expect(entry).toMatchObject({ kind: "curated", reason: "The earth isn't flat.", evidence: [] });
      expect(entry && "proposed" in entry).toBe(false);
    });

    it("is verified once k sessions used it with nothing against", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "release.md", {}, "Merge first.");
      await appendUses(base.dataDir, ["s1", "s2", "s3"].map((s, i) => use("curated/release.md", ALICE, s, `t${i}`)));

      await runDreaming(deps(base, judgeOf(() => keep).judge).deps);

      expect((await readNote(base.vaultPath, "curated/release.md"))?.frontmatter.status).toBe("verified");
    });

    it("once a person validated it, is contested again only by k sessions against after their decision", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "release.md", { status: "validated", validated_at: "2026-11-14T00:00:00.000Z" }, "Tag first.");
      const against = (req: JudgeRequest): Judgment => ({ ...keep, contradictedBy: req.excerpts.map((e) => e.turnId), obviouslyWrong: true, reason: "again" });
      const { judge } = judgeOf(against);

      await appendUses(base.dataDir, [use("curated/release.md", ALICE, "s1", "t1"), use("curated/release.md", ALICE, "s2", "t2")]);
      await runDreaming(deps(base, judge).deps);
      expect((await readNote(base.vaultPath, "curated/release.md"))?.frontmatter.status).toBe("validated");

      await appendUses(base.dataDir, [use("curated/release.md", BOB, "s3", "t3")]);
      await runDreaming(deps(base, judge).deps);
      expect((await readNote(base.vaultPath, "curated/release.md"))?.frontmatter.status).toBe("contested");
    });

    it("counts nothing from before the person's decision", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "release.md", { status: "validated", validated_at: "2026-11-20T00:00:00.000Z" }, "Tag first.");
      await appendUses(base.dataDir, ["s1", "s2", "s3"].map((s, i) => use("curated/release.md", ALICE, s, `t${i}`)));
      const { judge } = judgeOf((req) => ({ ...keep, contradictedBy: req.excerpts.map((e) => e.turnId) }));

      await runDreaming(deps(base, judge).deps);

      expect((await readNote(base.vaultPath, "curated/release.md"))?.frontmatter.status).toBe("validated");
    });
  });

  describe("a note the nightly review just wrote", () => {
    it("is checked the same night even unused, on the model's knowledge alone, and marked unverified", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "from-raw.md", { author: "mercury-review" }, "Deploys on Fridays.");
      await writeCuratedNote(base.vaultPath, "by-a-person.md", { author: "luca" }, "Ours.");
      const { judge, asked } = judgeOf(() => keep);

      await runDreaming(deps(base, judge).deps);

      expect(asked).toEqual([{ kind: "curated", note: "curated/from-raw.md", body: "Deploys on Fridays.", excerpts: [] }]);
      expect((await readNote(base.vaultPath, "curated/from-raw.md"))?.frontmatter).toMatchObject({ status: "unverified", verified_at: NOW });
      expect((await readNote(base.vaultPath, "curated/by-a-person.md"))?.frontmatter.status).toBeUndefined();
    });

    it("is contested when plainly wrong", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "from-raw.md", { author: "mercury-review" }, "The earth is flat.");
      const { judge } = judgeOf(() => ({ ...keep, obviouslyWrong: true, reason: "It isn't." }));

      await runDreaming(deps(base, judge).deps);

      expect((await readNote(base.vaultPath, "curated/from-raw.md"))?.frontmatter.status).toBe("contested");
    });

    it("isn't checked again once it has a status", async () => {
      const base = await setup();
      await writeCuratedNote(base.vaultPath, "from-raw.md", { author: "mercury-review" }, "Deploys on Fridays.");
      const { judge, asked } = judgeOf(() => keep);
      await runDreaming(deps(base, judge).deps);
      await runDreaming(deps(base, judge).deps);
      expect(asked).toHaveLength(1);
    });
  });

  it("goes on with the other notes when one fails, logging it", async () => {
    const base = await setup();
    await writeCuratedNote(base.vaultPath, "a.md", {}, "A.");
    await writeCuratedNote(base.vaultPath, "b.md", {}, "B.");
    await appendUses(base.dataDir, ["a", "b"].map((n) => use(`curated/${n}.md`, ALICE, "s1", "t1")));
    const { judge } = judgeOf((req) => {
      if (req.note === "curated/a.md") throw new Error("model away");
      return { ...keep, obviouslyWrong: true, reason: "no" };
    });
    const run = deps(base, judge);

    await runDreaming(run.deps);

    expect(run.logs).toEqual(["dreaming: curated/a.md not checked: Error: model away"]);
    expect((await readNote(base.vaultPath, "curated/b.md"))?.frontmatter.status).toBe("contested");
  });

  it("leaves a note it couldn't read the conversations of, logging it, and checks it next time", async () => {
    const base = await setup();
    await writeCuratedNote(base.vaultPath, "a.md", {}, "A.");
    await appendUses(base.dataDir, [use("curated/a.md", ALICE, "s1", "t1")]);
    const away: ConversationStore = { ...storeOf([]), messages: async () => Promise.reject(new Error("store away")) };
    const run = deps(base, judgeOf(() => keep).judge, { conversations: away });

    await runDreaming(run.deps);

    expect(run.logs).toEqual(["dreaming: curated/a.md not checked: Error: store away"]);
    expect((await takeUses(base.dataDir)).map((u) => u.note)).toEqual(["curated/a.md"]);
  });

  it("skips a used note that's gone", async () => {
    const base = await setup();
    await appendUses(base.dataDir, [use("curated/gone.md", ALICE, "s1", "t1")]);
    const { judge, asked } = judgeOf(() => keep);
    const run = deps(base, judge);
    await runDreaming(run.deps);
    expect(asked).toEqual([]);
    expect(run.logs).toEqual([]);
  });
});

describe("createDreamingJudge", () => {
  type Call = { instructions: string; prompt: string };
  const answer = { contradicted_by: ["t1"], obviously_wrong: false, reason: "r", corrected_text: "c" };

  function fake() {
    const calls: Call[] = [];
    const generateObjectFn = async (params: Call) => (calls.push(params), { object: answer });
    return { calls, judge: createDreamingJudge({} as never, generateObjectFn as never) };
  }

  it("asks for a person's note with its turns, and maps the answer", async () => {
    const { calls, judge } = fake();
    const result = await judge({
      kind: "personal",
      note: "users/x/notes/plan.md",
      body: "Standup at 9.",
      excerpts: [{ turnId: "t1", messages: [{ role: "user", content: "it's at 10" }] }],
    });
    expect(result).toEqual({ contradictedBy: ["t1"], obviouslyWrong: false, reason: "r", correctedText: "c" });
    expect(calls[0]!.prompt).toBe("Note (users/x/notes/plan.md):\nStandup at 9.\n\nTurn t1:\nuser: it's at 10");
    expect(calls[0]!.instructions).toContain("a note the assistant keeps for one person");
    expect(calls[0]!.instructions).not.toContain("obviously_wrong: true");
  });

  it("tells it, for a curated note, to flag only what's plainly false about the world, never the team's own matters", async () => {
    const { calls, judge } = fake();
    await judge({ kind: "curated", note: "curated/release.md", body: "Tag first.", excerpts: [] });
    expect(calls[0]!.prompt).toBe("Note (curated/release.md):\nTag first.\n\nNo conversation used it yet.");
    expect(calls[0]!.instructions).toContain("the team's shared wiki");
    expect(calls[0]!.instructions).toContain("never about this team's own conventions, projects, people or tools");
    expect(calls[0]!.instructions).toContain("Never quote the conversations");
  });

  it("keeps only turn ids it was shown, so a made-up one can't become evidence", async () => {
    const calls: Call[] = [];
    const generateObjectFn = async (params: Call) => (calls.push(params), { object: { ...answer, contradicted_by: ["t1", "t-invented"] } });
    const judge = createDreamingJudge({} as never, generateObjectFn as never);
    const result = await judge({ kind: "curated", note: "curated/a.md", body: "A.", excerpts: [{ turnId: "t1", messages: [] }] });
    expect(result.contradictedBy).toEqual(["t1"]);
  });
});

describe("a status change that races a note's edit", () => {
  it("doesn't overwrite a person's edit made after the note was read", async () => {
    const base = await setup();
    await writePersonalNote(base.vaultPath, ALICE, "personal/notes/plan.md", {}, "Standup at 9.");
    const note = "users/static%3Aalice/notes/plan.md";
    await appendUses(base.dataDir, [use(note, ALICE, "s1", "t1")]);
    const judge: Judge = async () => {
      await writePersonalNote(base.vaultPath, ALICE, "personal/notes/plan.md", {}, "The person's own edit.");
      return { contradictedBy: ["t1"], obviouslyWrong: false, reason: "x", correctedText: "Standup at 10." };
    };

    await runDreaming(deps(base, judge).deps);

    expect((await readNote(base.vaultPath, note))?.body).toBe("The person's own edit.");
  });
});
