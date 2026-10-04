import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageConfirmation } from "@mercury-fw/plugin-types";
import { writeCuratedNote, writeInferredNote, writeConfirmationNote, writePersonalNote } from "./wiki-note.ts";
import { createWikiTools } from "./wiki-tools.ts";
import { initVault } from "./vault-init.ts";

const tempDirs: string[] = [];

// Every writer commits after writing: git add/commit fail outright against a
// non-repo, so the vault needs to be a real git repo before any write.
async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-wiki-tools-test-"));
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

const ALICE = "static:alice";
const BOB = "static:bob";

type Staged = Parameters<StageConfirmation>[0];

/** The tools for `key`, with a staging fake that records what was staged and hands back TOK1-xxxx. */
function toolsFor(vaultPath: string, key: string) {
  const staged: Staged[] = [];
  const stageConfirmation: StageConfirmation = async (action) => {
    staged.push(action);
    return "TOK1-xxxx";
  };
  return { tools: createWikiTools({ vaultPath, key, stageConfirmation }), staged };
}

/** Runs one tool with `input`, the way the model would. */
async function call(tool: { execute?: unknown }, input: unknown): Promise<Record<string, unknown>> {
  return (await (tool.execute as (i: unknown, o: never) => Promise<unknown>)(input, {} as never)) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const inferred = { confidence: "low" as const, derived_from: ["ep_1"], last_reviewed: null };

describe("createWikiTools", () => {
  it("list_files returns the common area plus the person's own notes, under personal/", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "glossary.md", {}, "Glossario.");
    await writePersonalNote(vaultPath, ALICE, "personal/notes/plan.md", {}, "alice's plan");
    await writeInferredNote(vaultPath, ALICE, "topic-x", inferred, "nota di alice");
    await writePersonalNote(vaultPath, BOB, "personal/notes/secret.md", {}, "bob's secret");
    await writeInferredNote(vaultPath, BOB, "topic-y", inferred, "nota di bob");

    const result = await call(toolsFor(vaultPath, ALICE).tools.list_files, {});

    expect(result).toEqual({
      ok: true,
      files: ["curated/glossary.md", "personal/inferred/topic-x.md", "personal/notes/plan.md"],
    });
  });

  it("read_file returns the content of a file the person can see", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "glossary.md", {}, "Glossario del team.");
    await writePersonalNote(vaultPath, ALICE, "personal/notes/plan.md", {}, "alice's plan");
    const { read_file } = toolsFor(vaultPath, ALICE).tools;

    expect(await call(read_file, { path: "curated/glossary.md" })).toEqual({ ok: true, content: expect.stringContaining("Glossario del team.") });
    expect(await call(read_file, { path: "personal/notes/plan.md" })).toEqual({ ok: true, content: expect.stringContaining("alice's plan") });
  });

  it("read_file returns a self-correctable error, not a throw, for another person's note, by any path", async () => {
    const vaultPath = await makeTempVault();
    await writePersonalNote(vaultPath, BOB, "personal/notes/secret.md", {}, "bob's secret");
    const { read_file } = toolsFor(vaultPath, ALICE).tools;

    for (const path of ["users/static%3Abob/notes/secret.md", "personal/../static%3Abob/notes/secret.md", "personal/notes/secret.md"]) {
      const result = await call(read_file, { path });
      expect(result.ok).toBe(false);
      expect(String(result.error)).not.toContain("bob's secret");
    }
  });

  it("write_file writes a note under personal/notes/, in the person's own area", async () => {
    const vaultPath = await makeTempVault();
    const { write_file } = toolsFor(vaultPath, ALICE).tools;

    expect(await call(write_file, { path: "personal/notes/standup.md", content: "Daily at 9." })).toEqual({ ok: true });

    const text = await readFile(join(vaultPath, "users/static%3Aalice/notes/standup.md"), "utf-8");
    expect(text).toContain("type: personal");
    expect(text).toContain("Daily at 9.");
  });

  it("write_file refuses the common area and points at promote_note, writing nothing", async () => {
    const vaultPath = await makeTempVault();
    const { write_file } = toolsFor(vaultPath, ALICE).tools;

    const result = await call(write_file, { path: "curated/standards/jira.md", content: "x" });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("promote_note");
    expect(await exists(join(vaultPath, "curated/standards/jira.md"))).toBe(false);
  });

  it("write_file can't reach the person's inferred notes, another person's area, or leave the vault", async () => {
    const vaultPath = await makeTempVault();
    const { write_file } = toolsFor(vaultPath, ALICE).tools;

    for (const path of [
      "personal/inferred/topic-x.md",
      "personal/notes/../../static%3Abob/notes/x.md",
      "users/static%3Abob/notes/x.md",
      "../escape.md",
    ]) {
      const result = await call(write_file, { path, content: "x" });
      expect(result.ok).toBe(false);
    }
    expect(await exists(join(vaultPath, "users/static%3Abob"))).toBe(false);
    expect(await exists(join(vaultPath, "users/static%3Aalice/inferred"))).toBe(false);
  });

  it("grep finds matches only in what the person can see, reporting the paths read_file takes", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "glossary.md", {}, "deploy on friday: never");
    await writePersonalNote(vaultPath, ALICE, "personal/notes/plan.md", {}, "deploy the API");
    await writePersonalNote(vaultPath, BOB, "personal/notes/plan.md", {}, "deploy bob's thing");

    const result = await call(toolsFor(vaultPath, ALICE).tools.grep, { pattern: "deploy" });

    expect(result).toEqual({
      ok: true,
      matches: [
        { path: "curated/glossary.md", line: 5, text: "deploy on friday: never" },
        { path: "personal/notes/plan.md", line: 5, text: "deploy the API" },
      ],
    });
  });

  describe("promote_note", () => {
    it("stages the copy into the common area behind a confirmation, and writes nothing yet", async () => {
      const vaultPath = await makeTempVault();
      await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Release on Tuesdays.");
      const { tools, staged } = toolsFor(vaultPath, ALICE);

      const result = await call(tools.promote_note, { from: "personal/notes/release.md", to: "standards/release.md" });

      expect(result).toMatchObject({
        ok: false,
        pendingConfirmation: true,
        token: "TOK1-xxxx",
        summary: "promote personal/notes/release.md to curated/standards/release.md",
      });
      expect(String(result.error)).toContain("Never mention the token");
      expect(staged.map((s) => s.describe)).toEqual(["promote personal/notes/release.md to curated/standards/release.md"]);
      expect(await exists(join(vaultPath, "curated/standards/release.md"))).toBe(false);
    });

    it("writes the note's text, as it was when staged, into the common area once confirmed", async () => {
      const vaultPath = await makeTempVault();
      await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Release on Tuesdays.");
      const { tools, staged } = toolsFor(vaultPath, ALICE);
      await call(tools.promote_note, { from: "personal/notes/release.md", to: "curated/standards/release.md" });
      await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Changed after staging.");

      expect(await staged[0]!.run()).toEqual({ ok: true, data: { promoted: "curated/standards/release.md" } });

      const text = await readFile(join(vaultPath, "curated/standards/release.md"), "utf-8");
      expect(text).toContain("type: curated");
      expect(text).toContain("Release on Tuesdays.");
      expect(text).not.toContain("type: personal");
      expect(text).not.toContain("Changed after staging.");
      // Bob sees it now, since it's in the common area.
      expect(await call(toolsFor(vaultPath, BOB).tools.read_file, { path: "curated/standards/release.md" })).toMatchObject({ ok: true });
    });

    it("refuses, without staging, a source outside personal/notes/ or one that doesn't exist", async () => {
      const vaultPath = await makeTempVault();
      await writeCuratedNote(vaultPath, "glossary.md", {}, "Glossario.");
      await writeInferredNote(vaultPath, ALICE, "topic-x", inferred, "nota di alice");
      await writePersonalNote(vaultPath, BOB, "personal/notes/secret.md", {}, "bob's secret");
      const { tools, staged } = toolsFor(vaultPath, ALICE);

      for (const from of [
        "curated/glossary.md",
        "personal/inferred/topic-x.md",
        "personal/notes/missing.md",
        "users/static%3Abob/notes/secret.md",
        "personal/notes/../../static%3Abob/notes/secret.md",
        // Regression: the prefix was checked on the text, before resolving, so
        // ".." reached the person's inferred notes and promoted them.
        "personal/notes/../inferred/topic-x.md",
      ]) {
        const result = await call(tools.promote_note, { from, to: "x.md" });
        expect(result.ok).toBe(false);
        expect(result.pendingConfirmation).toBeUndefined();
      }
      expect(staged).toEqual([]);
    });

    it("refuses, without staging, a destination outside the common area", async () => {
      const vaultPath = await makeTempVault();
      await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Release on Tuesdays.");
      const { tools, staged } = toolsFor(vaultPath, ALICE);

      for (const to of ["../users/static%3Abob/notes/x.md", "curated/../raw/x.md", "/etc/x.md", "", "curated/"]) {
        const result = await call(tools.promote_note, { from: "personal/notes/release.md", to });
        expect(result.ok).toBe(false);
      }
      expect(staged).toEqual([]);
    });
  });

  describe("promote_note onto an existing document", () => {
    it("refuses, without staging, a destination the common area already has: the note goes under another name", async () => {
      const vaultPath = await makeTempVault();
      await writeCuratedNote(vaultPath, "standards/release.md", {}, "The team's own.");
      await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Release on Tuesdays.");
      const { tools, staged } = toolsFor(vaultPath, ALICE);

      const result = await call(tools.promote_note, { from: "personal/notes/release.md", to: "standards/release.md" });

      expect(result).toEqual({
        ok: false,
        error: "Error: curated/standards/release.md already exists: promote the note under another name",
      });
      expect(staged).toEqual([]);
    });

    it("doesn't overwrite one that appeared between staging and confirmation", async () => {
      const vaultPath = await makeTempVault();
      await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Release on Tuesdays.");
      const { tools, staged } = toolsFor(vaultPath, ALICE);
      await call(tools.promote_note, { from: "personal/notes/release.md", to: "standards/release.md" });
      await writeCuratedNote(vaultPath, "standards/release.md", {}, "Written meanwhile.");

      expect(await staged[0]!.run()).toEqual({
        ok: false,
        error: "curated/standards/release.md already exists: promote the note under another name",
      });
      expect(await readFile(join(vaultPath, "curated/standards/release.md"), "utf-8")).toContain("Written meanwhile.");
    });

    // Regression for #154: the existence check and the write were separate
    // steps, so two people confirming a promotion to the same path at once
    // both passed the check and the second overwrote the first.
    it("of two promotions to the same path confirmed at once, exactly one lands", async () => {
      const vaultPath = await makeTempVault();
      await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Alice's release.");
      await writePersonalNote(vaultPath, BOB, "personal/notes/release.md", {}, "Bob's release.");
      const alice = toolsFor(vaultPath, ALICE);
      const bob = toolsFor(vaultPath, BOB);
      await call(alice.tools.promote_note, { from: "personal/notes/release.md", to: "standards/release.md" });
      await call(bob.tools.promote_note, { from: "personal/notes/release.md", to: "standards/release.md" });

      const results = await Promise.all([alice.staged[0]!.run(), bob.staged[0]!.run()]);

      expect(results).toEqual([
        { ok: true, data: { promoted: "curated/standards/release.md" } },
        { ok: false, error: "curated/standards/release.md already exists: promote the note under another name" },
      ]);
      expect(await readFile(join(vaultPath, "curated/standards/release.md"), "utf-8")).toContain("Alice's release.");
    });
  });

  // list_files and grep only see .md files: anything else would be written
  // and then invisible to everyone, the person who asked for it included.
  it("write_file and promote_note take only .md files", async () => {
    const vaultPath = await makeTempVault();
    await writePersonalNote(vaultPath, ALICE, "personal/notes/release.md", {}, "Release on Tuesdays.");
    const { tools, staged } = toolsFor(vaultPath, ALICE);

    expect((await call(tools.write_file, { path: "personal/notes/x.txt", content: "x" })).ok).toBe(false);
    expect((await call(tools.write_file, { path: "personal/notes/x", content: "x" })).ok).toBe(false);
    expect((await call(tools.promote_note, { from: "personal/notes/release.md", to: "standards/release.txt" })).ok).toBe(false);
    expect(staged).toEqual([]);
    expect(await exists(join(vaultPath, "users/static%3Aalice/notes/x.txt"))).toBe(false);
  });

  describe("resolve_reference", () => {
    const pending = {
      status: "pending" as const,
      requestedAt: "2026-07-27T12:20:00Z",
      resolvedAt: null,
      command: "jira issue delete KAN-1 --confirm",
    };

    it("reads the person's own confirmation note by token", async () => {
      const vaultPath = await makeTempVault();
      await writeConfirmationNote(vaultPath, ALICE, "j3h4b5", pending);

      const result = await call(toolsFor(vaultPath, ALICE).tools.resolve_reference, { token: "j3h4b5" });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("jira issue delete KAN-1 --confirm");
      expect(result.content).toContain("status: pending");
    });

    it("returns a self-correctable error for an unknown/expired token", async () => {
      const vaultPath = await makeTempVault();
      const result = await call(toolsFor(vaultPath, ALICE).tools.resolve_reference, { token: "nope00" });
      expect(result.ok).toBe(false);
    });

    it("cannot resolve another person's token even if the string matches, nor climb out with one", async () => {
      const vaultPath = await makeTempVault();
      await writeConfirmationNote(vaultPath, BOB, "j3h4b5", pending);
      const { resolve_reference } = toolsFor(vaultPath, ALICE).tools;

      expect((await call(resolve_reference, { token: "j3h4b5" })).ok).toBe(false);
      expect((await call(resolve_reference, { token: "../../static%3Abob/confirmations/j3h4b5" })).ok).toBe(false);
    });

    it("is not discoverable via list_files or grep — only resolve_reference reaches it", async () => {
      const vaultPath = await makeTempVault();
      await writeConfirmationNote(vaultPath, ALICE, "j3h4b5", pending);
      const { list_files, grep } = toolsFor(vaultPath, ALICE).tools;

      expect(await call(list_files, {})).toEqual({ ok: true, files: [] });
      expect(await call(grep, { pattern: "jira issue delete" })).toEqual({ ok: true, matches: [] });
    });
  });
});
