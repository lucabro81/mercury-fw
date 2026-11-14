/**
 * The review/ folder: one entry per curated note a person has to decide on,
 * opened by the nightly passes and decided with `mfw vault review`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideReview, listReviews, openReview, readReview, reviewId, type ReviewEntry } from "./review-entries.ts";
import { initVault } from "./vault-init.ts";
import { readNote, updateIndexFile, writeCuratedNote, writeToolCorrectionNote } from "./wiki-note.ts";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-review-entries-test-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function gitLog(vaultPath: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "log", "--format=%s"], { cwd: vaultPath, stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim().split("\n").filter(Boolean);
}

async function gitClean(vaultPath: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: vaultPath, stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim() === "";
}

const NOW = "2026-11-15T10:00:00.000Z";

const contested: Omit<ReviewEntry, "id"> = {
  note: "curated/release.md",
  kind: "curated",
  evidence: ["turn-1", "turn-2"],
  opened_at: "2026-11-14T04:00:00.000Z",
  reason: "Two people were told to tag before merging and said the order is the other way round.",
  proposed: "Merge first, then tag.",
};

describe("reviewId", () => {
  it("is the note's path without .md, folders joined by --", () => {
    expect(reviewId("curated/standards/jira-fields.md")).toBe("curated--standards--jira-fields");
  });
});

describe("openReview, readReview, listReviews", () => {
  it("writes one entry per note under review/, reads it back as it was opened, and commits it", async () => {
    const vaultPath = await makeTempVault();

    const id = await openReview(vaultPath, contested);

    expect(id).toBe("curated--release");
    expect(await readFile(join(vaultPath, "review/curated--release.md"), "utf-8")).toBe(
      "---\nnote: curated/release.md\nkind: curated\nevidence:\n  - turn-1\n  - turn-2\nopened_at: 2026-11-14T04:00:00.000Z\n" +
        "reason: Two people were told to tag before merging and said the order is the other way round.\n---\n\nMerge first, then tag.\n",
    );
    expect(await readReview(vaultPath, id)).toEqual({ id, ...contested });
    expect(await listReviews(vaultPath)).toEqual([{ id, ...contested }]);
    expect((await gitLog(vaultPath))[0]).toBe("review: open curated--release");
  });

  it("replaces the open entry of the same note instead of adding a second one", async () => {
    const vaultPath = await makeTempVault();
    await openReview(vaultPath, contested);
    await openReview(vaultPath, { ...contested, evidence: ["turn-9"], reason: "Newer reason." });

    expect((await listReviews(vaultPath)).map((e) => [e.id, e.evidence, e.reason])).toEqual([["curated--release", ["turn-9"], "Newer reason."]]);
  });

  // The reason is the model's text: kept in the frontmatter, it can't be mistaken for the proposed text, whatever it says.
  it("reads back a reason and a proposed text whatever they contain", async () => {
    const vaultPath = await makeTempVault();
    const tricky = { ...contested, reason: "It says:\n\n## Proposed\n\nnothing.", proposed: "# Title\n\n## Proposed\n\nbody" };
    const id = await openReview(vaultPath, tricky);
    expect(await readReview(vaultPath, id)).toEqual({ id, ...tricky });
  });

  it("refuses an empty proposed text, which accepting would turn into an empty note", async () => {
    await expect(openReview(await makeTempVault(), { ...contested, proposed: " " })).rejects.toThrow("a review entry's proposed text can't be empty");
  });

  it("keeps an entry with no proposed text without one", async () => {
    const vaultPath = await makeTempVault();
    const { proposed: _, ...standard } = { ...contested, note: "curated/standards/jira-fields.md", kind: "standard" as const };
    const id = await openReview(vaultPath, standard);
    expect(await readReview(vaultPath, id)).toEqual({ id, ...standard });
  });

  it("refuses an entry for a note outside curated/: a person's notes never go to review", async () => {
    const vaultPath = await makeTempVault();
    await expect(openReview(vaultPath, { ...contested, note: "users/zitadel%3A1/notes/plan.md" })).rejects.toThrow(
      "a review entry is for a curated note: users/zitadel%3A1/notes/plan.md",
    );
  });

  it("readReview is null for an id with no entry; listReviews is empty with no review/ folder", async () => {
    const vaultPath = await makeTempVault();
    expect(await readReview(vaultPath, "curated--nope")).toBeNull();
    expect(await listReviews(vaultPath)).toEqual([]);
  });

  it("readReview refuses an id that would leave review/", async () => {
    await expect(readReview(await makeTempVault(), "../curated/release")).rejects.toThrow("not a review id: ../curated/release");
  });
});

describe("decideReview", () => {
  it("accept on a curated note writes the proposed text, validates it and closes the entry, in one commit", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", { author: "mercury-review" }, "Tag first, then merge.");
    const id = await openReview(vaultPath, contested);
    const commits = (await gitLog(vaultPath)).length;

    expect(await decideReview(vaultPath, id, "accept", NOW)).toEqual({ note: "curated/release.md", outcome: "rewritten" });

    expect(await readNote(vaultPath, "curated/release.md")).toEqual({
      frontmatter: { type: "curated", author: "mercury-review", status: "validated", validated_at: NOW },
      body: "Merge first, then tag.",
    });
    expect(await readReview(vaultPath, id)).toBeNull();
    expect(await gitLog(vaultPath)).toHaveLength(commits + 1);
    expect((await gitLog(vaultPath))[0]).toBe("review: accept curated--release");
    expect(await gitClean(vaultPath)).toBe(true);
  });

  it("reject on a curated note keeps its text and validates it", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", {}, "Tag first, then merge.");
    const id = await openReview(vaultPath, contested);

    expect(await decideReview(vaultPath, id, "reject", NOW)).toEqual({ note: "curated/release.md", outcome: "kept" });

    expect(await readNote(vaultPath, "curated/release.md")).toEqual({
      frontmatter: { type: "curated", status: "validated", validated_at: NOW },
      body: "Tag first, then merge.",
    });
    expect(await readReview(vaultPath, id)).toBeNull();
    expect((await gitLog(vaultPath))[0]).toBe("review: reject curated--release");
  });

  it("accept on a standard deletes it and its index.md line", async () => {
    const vaultPath = await makeTempVault();
    await writeToolCorrectionNote(vaultPath, "jira", "fields", { confidence: "low", derived_from: ["t"], last_reviewed: null }, "Use --fields.");
    await updateIndexFile(vaultPath, () => "- [[standards/jira-fields]] — fields\n- [[release]] — releases\n");
    const id = await openReview(vaultPath, { note: "curated/standards/jira-fields.md", kind: "standard", evidence: ["t1"], opened_at: NOW, reason: "Failed in 3 sessions." });

    expect(await decideReview(vaultPath, id, "accept", NOW)).toEqual({ note: "curated/standards/jira-fields.md", outcome: "deleted" });

    expect(await readNote(vaultPath, "curated/standards/jira-fields.md")).toBeNull();
    expect(await readFile(join(vaultPath, "index.md"), "utf-8")).toBe("- [[release]] — releases\n");
    expect(await gitClean(vaultPath)).toBe(true);
  });

  it("reject on a standard validates it", async () => {
    const vaultPath = await makeTempVault();
    await writeToolCorrectionNote(vaultPath, "jira", "fields", { confidence: "low", derived_from: ["t"], last_reviewed: null }, "Use --fields.");
    const id = await openReview(vaultPath, { note: "curated/standards/jira-fields.md", kind: "standard", evidence: ["t1"], opened_at: NOW, reason: "Failed." });

    expect(await decideReview(vaultPath, id, "reject", NOW)).toEqual({ note: "curated/standards/jira-fields.md", outcome: "kept" });
    expect((await readNote(vaultPath, "curated/standards/jira-fields.md"))?.frontmatter).toMatchObject({ status: "validated", validated_at: NOW });
  });

  it("accept on a locked note writes the proposed text and leaves it locked, with no status", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", { locked: true }, "Tag first.");
    const id = await openReview(vaultPath, { ...contested, kind: "locked" });

    expect(await decideReview(vaultPath, id, "accept", NOW)).toEqual({ note: "curated/release.md", outcome: "rewritten" });
    expect(await readNote(vaultPath, "curated/release.md")).toEqual({ frontmatter: { type: "curated", locked: true }, body: "Merge first, then tag." });
  });

  it("reject on a locked note leaves it exactly as it was", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "release.md", { locked: true }, "Tag first.");
    const before = await readFile(join(vaultPath, "curated/release.md"), "utf-8");
    const id = await openReview(vaultPath, { ...contested, kind: "locked" });

    expect(await decideReview(vaultPath, id, "reject", NOW)).toEqual({ note: "curated/release.md", outcome: "kept" });
    expect(await readFile(join(vaultPath, "curated/release.md"), "utf-8")).toBe(before);
    expect(await readReview(vaultPath, id)).toBeNull();
  });

  it("closes the entry of a note that's gone since, saying so", async () => {
    const vaultPath = await makeTempVault();
    const id = await openReview(vaultPath, contested);
    expect(await decideReview(vaultPath, id, "accept", NOW)).toEqual({ note: "curated/release.md", outcome: "note-gone" });
    expect(await readReview(vaultPath, id)).toBeNull();
  });

  it("takes a curated note with no frontmatter (written by hand) as a curated document", async () => {
    const vaultPath = await makeTempVault();
    await Bun.write(join(vaultPath, "curated/release.md"), "Tag first.\n");
    const id = await openReview(vaultPath, contested);

    expect(await decideReview(vaultPath, id, "reject", NOW)).toEqual({ note: "curated/release.md", outcome: "kept" });
    expect(await readNote(vaultPath, "curated/release.md")).toEqual({
      frontmatter: { type: "curated", status: "validated", validated_at: NOW },
      body: "Tag first.",
    });
  });

  // A decision that fails must not lose the entry: the next commit's `git add -A` would sweep its deletion in.
  it("leaves the entry and the note as they were when the note can't take the decision", async () => {
    const vaultPath = await makeTempVault();
    await Bun.write(join(vaultPath, "curated/release.md"), "---\ntype: something-else\n---\n\nTag first.\n");
    const id = await openReview(vaultPath, contested);

    await expect(decideReview(vaultPath, id, "accept", NOW)).rejects.toThrow();

    expect(await readReview(vaultPath, id)).not.toBeNull();
    expect(await readFile(join(vaultPath, "curated/release.md"), "utf-8")).toBe("---\ntype: something-else\n---\n\nTag first.\n");
  });

  it("throws for an id with no entry", async () => {
    await expect(decideReview(await makeTempVault(), "curated--nope", "accept", NOW)).rejects.toThrow("no review entry curated--nope");
  });
});
