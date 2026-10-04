import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCuratedNote, writeInferredNote, writeRawEntry } from "./wiki-note.ts";
import {
  selfReviewRoots,
  listWikiFilesInRoots,
  readWikiFileInRoots,
  grepWikiInRoots,
} from "./wiki-read.ts";
import { initVault } from "./vault-init.ts";

const tempDirs: string[] = [];

// writeCuratedNote/writeInferredNote now commit after writing —
// git add/commit fail outright against a non-repo, so the vault needs to
// be a real git repo before any write, not just a bare temp dir.
async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-wiki-read-test-"));
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

async function seedVault(vaultPath: string) {
  await writeCuratedNote(vaultPath, "standards/jira-fields.md", {}, "Convenzioni sui campi custom.");
  await writeCuratedNote(vaultPath, "glossary.md", {}, "Glossario del team.");
  await writeInferredNote(
    vaultPath,
    "static:user-a",
    "ticket_closing_style",
    { confidence: "medium", derived_from: ["ep_1"], last_reviewed: null },
    "user-a chiude i ticket a lotti.",
  );
  await writeInferredNote(
    vaultPath,
    "static:user-b",
    "review_responsiveness",
    { confidence: "low", derived_from: ["ep_2"], last_reviewed: null },
    "user-b risponde alle review lentamente.",
  );
}

// #138: "the monorepo" missed a note saying "Monorepo".
describe("grepWikiInRoots", () => {
  it("ignores case", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "projects/names.md", {}, "Monorepo: MON");

    const matches = await grepWikiInRoots(vaultPath, selfReviewRoots(vaultPath), "the monorepo|monorepo");
    expect(matches.map((m) => [m.path, m.text])).toEqual([["curated/projects/names.md", "Monorepo: MON"]]);
  });
});

// The self-review job (nightly batch, not a per-person conversation) gets its
// own scope: curated/ + raw/, never a person's area: what consolidation
// derives and what the model wrote for someone stay theirs.
describe("selfReviewRoots-scoped reads", () => {
  async function seedWithRaw(vaultPath: string) {
    await seedVault(vaultPath);
    await writeRawEntry(vaultPath, "notes/pasted-readme.md", "Raw pasted content, not yet triaged.");
  }

  it("listWikiFilesInRoots includes curated/ and raw/, and excludes every person's area", async () => {
    const vaultPath = await makeTempVault();
    await seedWithRaw(vaultPath);

    const files = await listWikiFilesInRoots(vaultPath, selfReviewRoots(vaultPath));
    expect(files.sort()).toEqual(
      ["curated/glossary.md", "curated/standards/jira-fields.md", "raw/notes/pasted-readme.md"].sort(),
    );
    expect(files.some((f) => f.startsWith("users/"))).toBe(false);
  });

  it("readWikiFileInRoots reads curated/ and raw/ files but rejects a path in a person's area", async () => {
    const vaultPath = await makeTempVault();
    await seedWithRaw(vaultPath);
    const roots = selfReviewRoots(vaultPath);

    const rawContent = await readWikiFileInRoots(vaultPath, roots, "raw/notes/pasted-readme.md");
    expect(rawContent).toContain("Raw pasted content");

    await expect(
      readWikiFileInRoots(vaultPath, roots, "users/static%3Auser-a/inferred/ticket_closing_style.md"),
    ).rejects.toThrow();
  });

  it("grepWikiInRoots finds matches in curated/ and raw/, never in a person's area", async () => {
    const vaultPath = await makeTempVault();
    await seedWithRaw(vaultPath);

    const matches = await grepWikiInRoots(vaultPath, selfReviewRoots(vaultPath), "chiude i ticket");
    expect(matches).toEqual([]); // that phrase only exists in user-a's area

    const rawMatches = await grepWikiInRoots(vaultPath, selfReviewRoots(vaultPath), "not yet triaged");
    expect(rawMatches.length).toBe(1);
    expect(rawMatches[0]!.path).toBe("raw/notes/pasted-readme.md");
  });
});
