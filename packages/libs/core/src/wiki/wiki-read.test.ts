import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCuratedNote, writeInferredNote, writeRawEntry } from "./wiki-note.ts";
import {
  listWikiFiles,
  readWikiFile,
  grepWiki,
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
    "user-a",
    "ticket_closing_style",
    { confidence: "medium", derived_from: ["ep_1"], last_reviewed: null },
    "user-a chiude i ticket a lotti.",
  );
  await writeInferredNote(
    vaultPath,
    "user-b",
    "review_responsiveness",
    { confidence: "low", derived_from: ["ep_2"], last_reviewed: null },
    "user-b risponde alle review lentamente.",
  );
}

describe("listWikiFiles", () => {
  it("returns an empty list on a vault with no content yet", async () => {
    const vaultPath = await makeTempVault();
    const files = await listWikiFiles(vaultPath, "user-a");
    expect(files).toEqual([]);
  });

  it("lists all curated files plus only the caller's own inferred files", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    const files = await listWikiFiles(vaultPath, "user-a");
    expect(files.sort()).toEqual(
      [
        "curated/glossary.md",
        "curated/standards/jira-fields.md",
        "inferred/users/user-a/ticket_closing_style.md",
      ].sort(),
    );
    expect(files).not.toContain("inferred/users/user-b/review_responsiveness.md");
  });
});

describe("readWikiFile", () => {
  it("reads a curated file", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    const content = await readWikiFile(vaultPath, "user-a", "curated/glossary.md");
    expect(content).toContain("Glossario del team.");
  });

  it("reads the caller's own inferred file", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    const content = await readWikiFile(vaultPath, "user-a", "inferred/users/user-a/ticket_closing_style.md");
    expect(content).toContain("user-a chiude i ticket a lotti.");
  });

  it("rejects reading another user's inferred file", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    await expect(
      readWikiFile(vaultPath, "user-a", "inferred/users/user-b/review_responsiveness.md"),
    ).rejects.toThrow();
  });

  it("rejects a path-traversal attempt", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    await expect(readWikiFile(vaultPath, "user-a", "../../etc/passwd")).rejects.toThrow();
  });
});

describe("grepWiki", () => {
  it("finds matches in curated and the caller's own inferred files, not other users'", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    const matches = await grepWiki(vaultPath, "user-a", "chiude i ticket");
    expect(matches.length).toBe(1);
    expect(matches[0]!.path).toBe("inferred/users/user-a/ticket_closing_style.md");
    expect(matches[0]!.text).toContain("chiude i ticket a lotti");
  });

  // #138: "the monorepo" missed a note saying "Monorepo".
  it("ignores case", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    const matches = await grepWiki(vaultPath, "user-a", "CHIUDE I TICKET");
    expect(matches.map((m) => m.path)).toEqual(["inferred/users/user-a/ticket_closing_style.md"]);
  });

  it("finds a capitalised note with a lowercase pattern", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "projects/names.md", {}, "Monorepo: MON");

    const matches = await grepWiki(vaultPath, "user-a", "the monorepo|monorepo");
    expect(matches.map((m) => [m.path, m.text])).toEqual([["curated/projects/names.md", "Monorepo: MON"]]);
  });

  it("returns no matches for content that only exists in another user's inferred notes", async () => {
    const vaultPath = await makeTempVault();
    await seedVault(vaultPath);

    const matches = await grepWiki(vaultPath, "user-a", "risponde alle review");
    expect(matches).toEqual([]);
  });
});

// The self-review job (nightly batch, not a per-user conversation) needs a
// third scoping boundary distinct from allowedRoots(vaultPath, userId):
// curated/ + raw/, but NEVER inferred/ — that's reserved for
// deterministic, mechanically-written notes, off-limits here for the
// same reason it's off-limits to regular conversations.
describe("selfReviewRoots-scoped reads", () => {
  async function seedWithRaw(vaultPath: string) {
    await seedVault(vaultPath);
    await writeRawEntry(vaultPath, "notes/pasted-readme.md", "Raw pasted content, not yet triaged.");
  }

  it("listWikiFilesInRoots includes curated/ and raw/, and excludes inferred/ entirely", async () => {
    const vaultPath = await makeTempVault();
    await seedWithRaw(vaultPath);

    const files = await listWikiFilesInRoots(vaultPath, selfReviewRoots(vaultPath));
    expect(files.sort()).toEqual(
      ["curated/glossary.md", "curated/standards/jira-fields.md", "raw/notes/pasted-readme.md"].sort(),
    );
    expect(files.some((f) => f.startsWith("inferred/"))).toBe(false);
  });

  it("readWikiFileInRoots reads curated/ and raw/ files but rejects an inferred/ path", async () => {
    const vaultPath = await makeTempVault();
    await seedWithRaw(vaultPath);
    const roots = selfReviewRoots(vaultPath);

    const rawContent = await readWikiFileInRoots(vaultPath, roots, "raw/notes/pasted-readme.md");
    expect(rawContent).toContain("Raw pasted content");

    await expect(
      readWikiFileInRoots(vaultPath, roots, "inferred/users/user-a/ticket_closing_style.md"),
    ).rejects.toThrow();
  });

  it("grepWikiInRoots finds matches in curated/ and raw/, never in inferred/", async () => {
    const vaultPath = await makeTempVault();
    await seedWithRaw(vaultPath);

    const matches = await grepWikiInRoots(vaultPath, selfReviewRoots(vaultPath), "chiude i ticket");
    expect(matches).toEqual([]); // that phrase only exists in user-a's inferred note

    const rawMatches = await grepWikiInRoots(vaultPath, selfReviewRoots(vaultPath), "not yet triaged");
    expect(rawMatches.length).toBe(1);
    expect(rawMatches[0]!.path).toBe("raw/notes/pasted-readme.md");
  });
});

// The per-user root is inferred/users/<userId>: "." or ".." resolved it to
// inferred/users/ or inferred/ itself, so a channel handing such an id over
// let the model's read tools see every user's notes. Writes already refused it.
describe("per-user reads refuse a userId that isn't one path segment", () => {
  for (const userId of ["", ".", "..", "a/b", "a\\b"]) {
    it(`refuses ${JSON.stringify(userId)}`, async () => {
      const vault = await makeTempVault();
      await expect(listWikiFiles(vault, userId)).rejects.toThrow("invalid userId");
      await expect(readWikiFile(vault, userId, "curated/glossary.md")).rejects.toThrow("invalid userId");
      await expect(grepWiki(vault, userId, "x")).rejects.toThrow("invalid userId");
    });
  }
});
