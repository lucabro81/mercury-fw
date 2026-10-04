import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCuratedNote, writeInferredNote, writeRawEntry, writeToolCorrectionNote } from "./wiki-note.ts";
import { createSelfReviewTools } from "./self-review-tools.ts";
import { initVault } from "./vault-init.ts";
import { findOrphanCuratedDocs } from "./orphan-detector.ts";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-self-review-tools-test-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createSelfReviewTools", () => {
  it("list_files returns curated/ + raw/, never inferred/ even when it exists", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "glossary.md", {}, "Glossario.");
    await writeRawEntry(vaultPath, "notes/x.md", "pasted content");
    await writeInferredNote(
      vaultPath,
      "user-a",
      "topic-x",
      { confidence: "low", derived_from: ["ep_1"], last_reviewed: null },
      "nota inferita",
    );

    const { list_files } = createSelfReviewTools({ vaultPath });
    const result = (await list_files.execute({}, {} as never)) as { ok: true; files: string[] };

    expect(result.ok).toBe(true);
    expect(result.files).toContain("curated/glossary.md");
    expect(result.files).toContain("raw/notes/x.md");
    expect(result.files.some((f) => f.startsWith("inferred/"))).toBe(false);
  });

  it("read_file reads curated/ and raw/ but rejects an inferred/ path", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/x.md", "pasted content");
    await writeInferredNote(
      vaultPath,
      "user-a",
      "topic-x",
      { confidence: "low", derived_from: ["ep_1"], last_reviewed: null },
      "nota inferita",
    );

    const { read_file } = createSelfReviewTools({ vaultPath });
    const rawResult = (await read_file.execute({ path: "raw/notes/x.md" }, {} as never)) as
      | { ok: true; content: string }
      | { ok: false; error: string };
    expect(rawResult.ok).toBe(true);
    if (rawResult.ok) expect(rawResult.content).toContain("pasted content");

    const inferredResult = (await read_file.execute(
      { path: "inferred/users/user-a/topic-x.md" },
      {} as never,
    )) as { ok: true; content: string } | { ok: false; error: string };
    expect(inferredResult.ok).toBe(false);
  });

  it("grep finds matches in curated/ and raw/, never in inferred/", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/x.md", "pattern-unico");
    await writeInferredNote(
      vaultPath,
      "user-a",
      "topic-x",
      { confidence: "low", derived_from: ["ep_1"], last_reviewed: null },
      "pattern-unico",
    );

    const { grep } = createSelfReviewTools({ vaultPath });
    const result = (await grep.execute({ pattern: "pattern-unico" }, {} as never)) as
      | { ok: true; matches: { path: string; line: number; text: string }[] }
      | { ok: false; error: string };

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches.length).toBe(1);
      expect(result.matches[0]!.path).toBe("raw/notes/x.md");
    }
  });

  it("write_curated writes a curated doc", async () => {
    const vaultPath = await makeTempVault();
    const { write_curated } = createSelfReviewTools({ vaultPath });

    const result = (await write_curated.execute(
      { path: "standards/new-doc.md", content: "Nuovo standard." },
      {} as never,
    )) as { ok: true } | { ok: false; error: string };

    expect(result.ok).toBe(true);
    const text = await readFile(join(vaultPath, "curated/standards/new-doc.md"), "utf-8");
    expect(text).toContain("Nuovo standard.");
    expect(text).toContain("type: curated");
  });

  // #138: the review's list_files and grep give curated/… paths too.
  it("write_curated takes the vault-relative path list_files and grep give, too", async () => {
    const vaultPath = await makeTempVault();
    const { write_curated } = createSelfReviewTools({ vaultPath });

    const result = (await write_curated.execute({ path: "curated/standards/x.md", content: "X." }, {} as never)) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(await readFile(join(vaultPath, "curated/standards/x.md"), "utf-8")).toContain("X.");
    await expect(readFile(join(vaultPath, "curated/curated/standards/x.md"), "utf-8")).rejects.toThrow();
  });

  it("update_index_entry writes a [[wikilink]] line for an existing curated doc", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "projects/project-codes.md", {}, "MON = monorepo");
    const { update_index_entry } = createSelfReviewTools({ vaultPath });

    const result = (await update_index_entry.execute(
      { path: "curated/projects/project-codes.md", description: "Project name to code mapping" },
      {} as never,
    )) as { ok: true } | { ok: false; error: string };

    expect(result.ok).toBe(true);
    const text = await readFile(join(vaultPath, "index.md"), "utf-8");
    expect(text).toBe("- [[projects/project-codes]] — Project name to code mapping\n");
  });

  it("update_index_entry normalizes curated/, .md, and bare path forms to the same entry, without duplicating it", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "projects/project-codes.md", {}, "MON = monorepo");
    const { update_index_entry } = createSelfReviewTools({ vaultPath });

    await update_index_entry.execute({ path: "projects/project-codes.md", description: "first pass" }, {} as never);
    const result = (await update_index_entry.execute(
      { path: "curated/projects/project-codes", description: "updated description" },
      {} as never,
    )) as { ok: true } | { ok: false; error: string };

    expect(result.ok).toBe(true);
    const text = await readFile(join(vaultPath, "index.md"), "utf-8");
    expect(text).toBe("- [[projects/project-codes]] — updated description\n");
  });

  it("update_index_entry errors, and writes nothing, when the curated doc doesn't exist", async () => {
    const vaultPath = await makeTempVault();
    const { update_index_entry } = createSelfReviewTools({ vaultPath });

    const result = (await update_index_entry.execute(
      { path: "projects/project-codes.md", description: "Project name to code mapping" },
      {} as never,
    )) as { ok: true } | { ok: false; error: string };

    expect(result).toEqual({
      ok: false,
      error: "curated/projects/project-codes.md does not exist — create it first with write_curated",
    });
    await expect(readFile(join(vaultPath, "index.md"), "utf-8")).rejects.toThrow();
  });

  // Regression for #154: index.md was read, then written in a separate step,
  // so two updates in one step (the SDK runs a step's tool calls together)
  // both started from the same index and one entry was lost.
  it("concurrent update_index_entry calls keep every entry", async () => {
    const vaultPath = await makeTempVault();
    const docs = ["a", "b", "c", "d"];
    for (const doc of docs) await writeCuratedNote(vaultPath, `${doc}.md`, {}, doc);
    const { update_index_entry } = createSelfReviewTools({ vaultPath });

    await Promise.all(docs.map((doc) => update_index_entry.execute({ path: doc, description: `about ${doc}` }, {} as never)));

    const index = await readFile(join(vaultPath, "index.md"), "utf-8");
    for (const doc of docs) expect(index).toContain(`[[${doc}]]`);
  });

  it("remove_index_entry removes an existing entry", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "glossary.md", {}, "body");
    const { update_index_entry, remove_index_entry } = createSelfReviewTools({ vaultPath });
    await update_index_entry.execute({ path: "curated/glossary.md", description: "team glossary" }, {} as never);

    const result = (await remove_index_entry.execute({ path: "glossary.md" }, {} as never)) as
      | { ok: true }
      | { ok: false; error: string };

    expect(result.ok).toBe(true);
    const text = await readFile(join(vaultPath, "index.md"), "utf-8");
    expect(text).toBe("\n");
  });

  it("remove_index_entry is a no-op when the entry doesn't exist", async () => {
    const vaultPath = await makeTempVault();
    const { remove_index_entry } = createSelfReviewTools({ vaultPath });

    const result = (await remove_index_entry.execute({ path: "curated/glossary.md" }, {} as never)) as
      | { ok: true }
      | { ok: false; error: string };

    expect(result.ok).toBe(true);
  });

  // Regression: with the old free-form write_index tool, a model could write
  // an index.md line ("path: description", no [[wikilink]]) that looked fine
  // but findOrphanCuratedDocs' wikilink check didn't recognize — the doc got
  // re-flagged as orphaned every night regardless. update_index_entry can't
  // produce that shape at all.
  it("a doc indexed via update_index_entry is no longer reported as orphaned", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "projects/project-codes.md", {}, "MON = monorepo");
    const { update_index_entry } = createSelfReviewTools({ vaultPath });

    await update_index_entry.execute(
      { path: "curated/projects/project-codes.md", description: "Project name to code mapping" },
      {} as never,
    );

    expect(await findOrphanCuratedDocs(vaultPath)).toEqual([]);
  });

  it("delete_raw deletes an existing raw/ entry", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/x.md", "body");
    const { delete_raw } = createSelfReviewTools({ vaultPath });

    const result = (await delete_raw.execute({ path: "raw/notes/x.md" }, {} as never)) as
      | { ok: true }
      | { ok: false; error: string };

    expect(result.ok).toBe(true);
    await expect(readFile(join(vaultPath, "raw/notes/x.md"), "utf-8")).rejects.toThrow();
  });

  it("delete_raw rejects a path outside raw/, so it can't be used to delete curated content", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/x.md", {}, "body");
    const { delete_raw } = createSelfReviewTools({ vaultPath });

    const result = (await delete_raw.execute({ path: "curated/standards/x.md" }, {} as never)) as
      | { ok: true }
      | { ok: false; error: string };

    expect(result.ok).toBe(false);
    const text = await readFile(join(vaultPath, "curated/standards/x.md"), "utf-8");
    expect(text).toContain("body");
  });

  it("delete_curated deletes an existing curated/ doc", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/superseded.md", {}, "body");
    const { read_file, delete_curated } = createSelfReviewTools({ vaultPath });
    await read_file.execute({ path: "curated/standards/superseded.md" }, {} as never);

    const result = (await delete_curated.execute({ path: "curated/standards/superseded.md" }, {} as never)) as
      | { ok: true }
      | { ok: false; error: string };

    expect(result.ok).toBe(true);
    await expect(readFile(join(vaultPath, "curated/standards/superseded.md"), "utf-8")).rejects.toThrow();
  });

  it("delete_curated rejects a path outside curated/, so it can't be used to delete raw content", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/x.md", "body");
    const { delete_curated } = createSelfReviewTools({ vaultPath });

    const result = (await delete_curated.execute({ path: "raw/notes/x.md" }, {} as never)) as
      | { ok: true }
      | { ok: false; error: string };

    expect(result.ok).toBe(false);
    const text = await readFile(join(vaultPath, "raw/notes/x.md"), "utf-8");
    expect(text).toContain("body");
  });

  // #154: a pass reads a doc, reasons for several steps, and rewrites it
  // whole; whatever landed in between (a tool correction from someone's
  // turn, a promotion) was lost. The review now writes or deletes only the
  // version it read.
  describe("only over the version it read", () => {
    type Result = { ok: true } | { ok: false; error: string };
    const correction = { confidence: "low" as const, derived_from: ["t1"], last_reviewed: null };

    it("refuses to write a doc that changed since it was read, then writes once it's read again", async () => {
      const vaultPath = await makeTempVault();
      await writeToolCorrectionNote(vaultPath, "jira", "select", correction, "old rule");
      const { read_file, write_curated } = createSelfReviewTools({ vaultPath });

      await read_file.execute({ path: "curated/standards/jira-select.md" }, {} as never);
      await writeToolCorrectionNote(vaultPath, "jira", "select", { ...correction, derived_from: ["t1", "t2"] }, "new rule");
      const refused = (await write_curated.execute(
        { path: "curated/standards/jira-select.md", content: "merged from the old rule" },
        {} as never,
      )) as Result;

      expect(refused).toEqual({
        ok: false,
        error: "curated/standards/jira-select.md changed since you read it: read it again and redo your edit on the current version",
      });
      expect(await readFile(join(vaultPath, "curated/standards/jira-select.md"), "utf-8")).toContain("new rule");

      await read_file.execute({ path: "curated/standards/jira-select.md" }, {} as never);
      const written = (await write_curated.execute(
        { path: "standards/jira-select.md", content: "merged, new rule included" },
        {} as never,
      )) as Result;

      expect(written).toEqual({ ok: true });
      expect(await readFile(join(vaultPath, "curated/standards/jira-select.md"), "utf-8")).toContain("new rule included");
    });

    it("refuses to overwrite a doc it never read, and to write again without rereading what it wrote", async () => {
      const vaultPath = await makeTempVault();
      await writeCuratedNote(vaultPath, "glossary.md", {}, "team glossary");
      const { write_curated } = createSelfReviewTools({ vaultPath });

      const unread = (await write_curated.execute({ path: "glossary.md", content: "x" }, {} as never)) as Result;
      expect(unread).toEqual({
        ok: false,
        error: "curated/glossary.md already exists: read it first, then write your edited version",
      });
      expect(await readFile(join(vaultPath, "curated/glossary.md"), "utf-8")).toContain("team glossary");

      expect(((await write_curated.execute({ path: "new.md", content: "first" }, {} as never)) as Result).ok).toBe(true);
      expect(((await write_curated.execute({ path: "new.md", content: "second" }, {} as never)) as Result).ok).toBe(false);
    });

    it("refuses to delete a doc that changed since it was read, or one it never read", async () => {
      const vaultPath = await makeTempVault();
      await writeCuratedNote(vaultPath, "a.md", {}, "a");
      await writeCuratedNote(vaultPath, "b.md", {}, "b");
      const { read_file, delete_curated } = createSelfReviewTools({ vaultPath });

      await read_file.execute({ path: "curated/a.md" }, {} as never);
      await writeCuratedNote(vaultPath, "a.md", {}, "a, edited meanwhile");

      expect(await delete_curated.execute({ path: "curated/a.md" }, {} as never)).toEqual({
        ok: false,
        error: "curated/a.md changed since you read it: read it again and redo your edit on the current version",
      });
      expect(await delete_curated.execute({ path: "curated/b.md" }, {} as never)).toEqual({
        ok: false,
        error: "curated/b.md: read it first, then delete it",
      });
      expect(await readFile(join(vaultPath, "curated/a.md"), "utf-8")).toContain("edited meanwhile");
      expect(await readFile(join(vaultPath, "curated/b.md"), "utf-8")).toContain("b");
    });

    it("deleting a doc that's already gone is still a no-op success", async () => {
      const vaultPath = await makeTempVault();
      const { delete_curated } = createSelfReviewTools({ vaultPath });
      expect(await delete_curated.execute({ path: "curated/never.md" }, {} as never)).toEqual({ ok: true });
    });
  });
});

