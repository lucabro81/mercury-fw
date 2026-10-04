import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  writeCuratedNote,
  writeInferredNote,
  writePersonalNote,
  writeToolCorrectionNote,
  writeRawEntry,
  deleteRawEntry,
  deleteCuratedEntry,
  writeConfirmationNote,
  updateIndexFile,
} from "./wiki-note.ts";
import { initVault } from "./vault-init.ts";

const tempDirs: string[] = [];

// Every writer now commits after writing (every vault write is a
// commit) — git add/commit fail outright against a non-repo, so every test
// needs a real git-inited vault, not just a bare temp dir.
async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-wiki-note-test-"));
  tempDirs.push(dir);
  await initVault(dir);
  return dir;
}

async function gitLog(vaultPath: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "log", "--format=%s"], { cwd: vaultPath, stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim().split("\n").filter(Boolean);
}

async function gitStatusPorcelain(vaultPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: vaultPath, stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

// A pre-commit hook that always fails deterministically breaks `git commit`
// specifically (hooks don't run on `git add`) — lets a test reproduce "file
// written, commit failed" without touching production code for injectability.
async function breakCommits(vaultPath: string): Promise<void> {
  const hookPath = join(vaultPath, ".git", "hooks", "pre-commit");
  await mkdir(join(vaultPath, ".git", "hooks"), { recursive: true });
  await writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf-8");
  await chmod(hookPath, 0o755);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function splitFrontmatter(fileText: string): { frontmatter: unknown; body: string } {
  const match = fileText.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) throw new Error("file does not have the expected frontmatter shape");
  return { frontmatter: parseYaml(match[1]!), body: match[2]! };
}

describe("writeCuratedNote", () => {
  it("writes a file under curated/ with type: curated frontmatter and the given body", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", { author: "luca" }, "Convenzioni sui campi custom.");

    const text = await readFile(join(vaultPath, "curated/standards/jira-fields.md"), "utf-8");
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toEqual({ type: "curated", author: "luca" });
    expect(body).toBe("Convenzioni sui campi custom.\n");
  });

  it("refuses to write outside the vault via a path-traversing relativePath", async () => {
    const vaultPath = await makeTempVault();
    await expect(
      writeCuratedNote(vaultPath, "../../etc/evil.md", {}, "pwned"),
    ).rejects.toThrow();
  });

  // Every vault write is a commit — audit trail + `git revert` as a
  // safety net. Regression: a write that lands on disk but is never
  // committed silently breaks that guarantee.
  it("commits the write, leaving a clean working tree", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", { author: "luca" }, "body");

    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("standards/jira-fields.md");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("commits as Mercury's own git identity, with a generic address", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", { author: "luca" }, "body");

    const proc = Bun.spawn(["git", "log", "-1", "--format=%an <%ae>"], { cwd: vaultPath, stdout: "pipe" });
    const author = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(author).toBe("Mercury <mercury@mercury.local>");
  });

  // Found by hand via the maintenance CLI: writing byte-identical content
  // twice made `git commit` fail with "nothing to commit" (a legitimate git
  // outcome, since there's no diff to record) — but that surfaced as a
  // thrown error to the caller, which is surprising: asking the vault to
  // contain X, when it already contains exactly X, should succeed as a
  // no-op, not fail.
  it("succeeds as a no-op, without a new commit, when the content is byte-identical to what's already there", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/jira-fields.md", { author: "luca" }, "body");
    const logAfterFirst = await gitLog(vaultPath);

    await writeCuratedNote(vaultPath, "standards/jira-fields.md", { author: "luca" }, "body");

    const logAfterSecond = await gitLog(vaultPath);
    expect(logAfterSecond.length).toBe(logAfterFirst.length);
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });
});

describe("writeInferredNote", () => {
  it("writes a file in the person's area, users/<encoded key>/inferred/<topic>.md, with full frontmatter", async () => {
    const vaultPath = await makeTempVault();
    await writeInferredNote(
      vaultPath,
      "google-chat:users/42",
      "ticket_closing_style",
      { confidence: "medium", derived_from: ["ep_a1b2", "ep_c3d4"], last_reviewed: null },
      "L'utente tende a chiudere i ticket a lotti.",
    );

    const text = await readFile(join(vaultPath, "users/google-chat%3Ausers%2F42/inferred/ticket_closing_style.md"), "utf-8");
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toEqual({
      type: "inferred",
      source: "agent",
      confidence: "medium",
      derived_from: ["ep_a1b2", "ep_c3d4"],
      last_reviewed: null,
    });
    expect(body).toBe("L'utente tende a chiudere i ticket a lotti.\n");
  });

  it("commits the write, leaving a clean working tree", async () => {
    const vaultPath = await makeTempVault();
    await writeInferredNote(
      vaultPath,
      "google-chat:users/42",
      "ticket_closing_style",
      { confidence: "medium", derived_from: ["ep_a1b2"], last_reviewed: null },
      "body",
    );

    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("google-chat:users/42/ticket_closing_style");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("rejects an invalid confidence value before writing anything", async () => {
    const vaultPath = await makeTempVault();
    await expect(
      writeInferredNote(
        vaultPath,
        "google-chat:users/42",
        "ticket_closing_style",
        // @ts-expect-error deliberately invalid for the test
        { confidence: "very-high", derived_from: ["ep_a1b2"], last_reviewed: null },
        "body",
      ),
    ).rejects.toThrow();
  });

  it("rejects a topic containing a path separator", async () => {
    const vaultPath = await makeTempVault();
    await expect(
      writeInferredNote(
        vaultPath,
        "google-chat:users/42",
        "../../evil",
        { confidence: "low", derived_from: ["ep_a1b2"], last_reviewed: null },
        "body",
      ),
    ).rejects.toThrow();
  });

  it("keeps a key full of separators inside that person's area", async () => {
    const vaultPath = await makeTempVault();
    await writeInferredNote(
      vaultPath,
      "static:../../evil",
      "ticket_closing_style",
      { confidence: "low", derived_from: ["ep_a1b2"], last_reviewed: null },
      "body",
    );
    expect(await readFile(join(vaultPath, "users/static%3A..%2F..%2Fevil/inferred/ticket_closing_style.md"), "utf-8")).toContain("body");
  });
});

describe("writePersonalNote", () => {
  it("writes a note the model asked for under personal/notes/ into the person's notes folder", async () => {
    const vaultPath = await makeTempVault();
    await writePersonalNote(vaultPath, "static:alice", "personal/notes/plans/q4.md", { last_updated: "2026-10-04" }, "Ship #38.");

    const text = await readFile(join(vaultPath, "users/static%3Aalice/notes/plans/q4.md"), "utf-8");
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toEqual({ type: "personal", last_updated: "2026-10-04" });
    expect(body).toBe("Ship #38.\n");
    expect((await gitLog(vaultPath))[0]).toContain("personal: static:alice/plans/q4.md");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("refuses the common area and anything outside personal/notes/, writing nothing", async () => {
    const vaultPath = await makeTempVault();
    await expect(writePersonalNote(vaultPath, "static:alice", "curated/x.md", {}, "x")).rejects.toThrow("promote_note");
    await expect(writePersonalNote(vaultPath, "static:alice", "personal/inferred/x.md", {}, "x")).rejects.toThrow(
      "not writable",
    );
    await expect(writePersonalNote(vaultPath, "static:alice", "personal/notes/../../static%3Abob/notes/x.md", {}, "x")).rejects.toThrow(
      "not writable",
    );
    expect(await gitLog(vaultPath)).toEqual([]);
  });
});

describe("writeToolCorrectionNote", () => {
  it("writes a file under curated/standards/<tool>-<topic>.md with full frontmatter", async () => {
    const vaultPath = await makeTempVault();
    await writeToolCorrectionNote(
      vaultPath,
      "jira",
      "select-prefix",
      { confidence: "high", derived_from: ["2026-07-20T09:00:00.000Z"], last_reviewed: null },
      "Ogni --select deve iniziare per issues.",
    );

    const text = await readFile(join(vaultPath, "curated/standards/jira-select-prefix.md"), "utf-8");
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toEqual({
      type: "inferred",
      source: "agent",
      confidence: "high",
      derived_from: ["2026-07-20T09:00:00.000Z"],
      last_reviewed: null,
    });
    expect(body).toBe("Ogni --select deve iniziare per issues.\n");
  });

  it("commits the write, leaving a clean working tree", async () => {
    const vaultPath = await makeTempVault();
    await writeToolCorrectionNote(
      vaultPath,
      "jira",
      "select-prefix",
      { confidence: "high", derived_from: ["2026-07-20T09:00:00.000Z"], last_reviewed: null },
      "body",
    );

    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("standards/jira-select-prefix");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("rejects a tool name containing a path separator", async () => {
    const vaultPath = await makeTempVault();
    await expect(
      writeToolCorrectionNote(
        vaultPath,
        "../../evil",
        "select-prefix",
        { confidence: "low", derived_from: ["x"], last_reviewed: null },
        "body",
      ),
    ).rejects.toThrow();
  });

  it("rejects a topic containing a path separator", async () => {
    const vaultPath = await makeTempVault();
    await expect(
      writeToolCorrectionNote(
        vaultPath,
        "jira",
        "../../evil",
        { confidence: "low", derived_from: ["x"], last_reviewed: null },
        "body",
      ),
    ).rejects.toThrow();
  });
});

describe("writeRawEntry", () => {
  it("writes verbatim content under raw/<relativePath>, with no frontmatter", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/pasted-readme.md", "# Some README\n\nBody text.");

    const text = await readFile(join(vaultPath, "raw/notes/pasted-readme.md"), "utf-8");
    expect(text).toBe("# Some README\n\nBody text.\n");
    expect(text.startsWith("---\n")).toBe(false);
  });

  it("refuses to write outside raw/ via a path-traversing relativePath", async () => {
    const vaultPath = await makeTempVault();
    await expect(writeRawEntry(vaultPath, "../curated/evil.md", "pwned")).rejects.toThrow();
  });

  it("commits the write, leaving a clean working tree", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/pasted-readme.md", "body");

    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("notes/pasted-readme.md");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("succeeds as a no-op, without a new commit, when the content is byte-identical to what's already there", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/pasted-readme.md", "body");
    const logAfterFirst = await gitLog(vaultPath);

    await writeRawEntry(vaultPath, "notes/pasted-readme.md", "body");

    const logAfterSecond = await gitLog(vaultPath);
    expect(logAfterSecond.length).toBe(logAfterFirst.length);
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });
});

describe("updateIndexFile", () => {
  it("writes verbatim content at the vault root as index.md, with no frontmatter", async () => {
    const vaultPath = await makeTempVault();
    await updateIndexFile(vaultPath, () => "- [[standards/jira-fields]] — custom field conventions");

    const text = await readFile(join(vaultPath, "index.md"), "utf-8");
    expect(text).toBe("- [[standards/jira-fields]] — custom field conventions\n");
    expect(text.startsWith("---\n")).toBe(false);
  });

  it("commits the write, leaving a clean working tree", async () => {
    const vaultPath = await makeTempVault();
    await updateIndexFile(vaultPath, () => "index content");

    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("index");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });
});

describe("deleteRawEntry", () => {
  it("removes an existing raw/ entry and commits the deletion", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/pasted-readme.md", "body");

    await deleteRawEntry(vaultPath, "notes/pasted-readme.md");

    await expect(readFile(join(vaultPath, "raw/notes/pasted-readme.md"), "utf-8")).rejects.toThrow();
    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("notes/pasted-readme.md");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("refuses to delete outside raw/ via a path-traversing relativePath", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/x.md", {}, "body");
    await expect(deleteRawEntry(vaultPath, "../curated/standards/x.md")).rejects.toThrow();

    const text = await readFile(join(vaultPath, "curated/standards/x.md"), "utf-8");
    expect(text).toContain("body");
  });

  it("succeeds as a no-op when the target doesn't exist", async () => {
    const vaultPath = await makeTempVault();
    await expect(deleteRawEntry(vaultPath, "never-existed.md")).resolves.toBeUndefined();
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });
});

describe("deleteCuratedEntry", () => {
  it("removes an existing curated/ entry and commits the deletion", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/superseded.md", {}, "body");

    await deleteCuratedEntry(vaultPath, "standards/superseded.md");

    await expect(readFile(join(vaultPath, "curated/standards/superseded.md"), "utf-8")).rejects.toThrow();
    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("standards/superseded.md");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("refuses to delete outside curated/ via a path-traversing relativePath", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/x.md", "body");
    await expect(deleteCuratedEntry(vaultPath, "../raw/notes/x.md")).rejects.toThrow();

    const text = await readFile(join(vaultPath, "raw/notes/x.md"), "utf-8");
    expect(text).toContain("body");
  });

  it("succeeds as a no-op when the target doesn't exist", async () => {
    const vaultPath = await makeTempVault();
    await expect(deleteCuratedEntry(vaultPath, "never-existed.md")).resolves.toBe(true);
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });
});

// Regression guard for the stale-primer bug: a confirm-required action's
// lifecycle (staged, then confirmed/failed) must live somewhere the model
// can't stumble onto by browsing (a person's confirmations/ folder is outside
// what identity/vault-access.ts exposes to the model's own tools) but
// Mercury's own code can still read deterministically: see resolve_reference
// in wiki-tools.ts and the "Riferimenti aperti" section in context-primer.ts.
describe("writeConfirmationNote", () => {
  it("writes a note in the person's area, users/<encoded key>/confirmations/<token>.md", async () => {
    const vaultPath = await makeTempVault();
    await writeConfirmationNote(vaultPath, "google-chat:users/42", "j3h4b5", {
      status: "pending",
      requestedAt: "2026-07-27T12:20:00Z",
      resolvedAt: null,
      command: "jira issue delete KAN-1 --confirm",
    });

    const text = await readFile(join(vaultPath, "users/google-chat%3Ausers%2F42/confirmations/j3h4b5.md"), "utf-8");
    const { frontmatter } = splitFrontmatter(text);
    expect(frontmatter).toEqual({
      type: "confirmation",
      status: "pending",
      requested_at: "2026-07-27T12:20:00Z",
      resolved_at: null,
      command: "jira issue delete KAN-1 --confirm",
    });
  });

  it("overwrites the same note when the action is later resolved", async () => {
    const vaultPath = await makeTempVault();
    await writeConfirmationNote(vaultPath, "google-chat:users/42", "j3h4b5", {
      status: "pending",
      requestedAt: "2026-07-27T12:20:00Z",
      resolvedAt: null,
      command: "jira issue delete KAN-1 --confirm",
    });
    await writeConfirmationNote(vaultPath, "google-chat:users/42", "j3h4b5", {
      status: "confirmed",
      requestedAt: "2026-07-27T12:20:00Z",
      resolvedAt: "2026-07-27T12:25:00Z",
      command: "jira issue delete KAN-1 --confirm",
    });

    const text = await readFile(join(vaultPath, "users/google-chat%3Ausers%2F42/confirmations/j3h4b5.md"), "utf-8");
    const { frontmatter } = splitFrontmatter(text);
    expect(frontmatter).toMatchObject({ status: "confirmed", resolved_at: "2026-07-27T12:25:00Z" });
  });

  it("commits the write, leaving a clean working tree", async () => {
    const vaultPath = await makeTempVault();
    await writeConfirmationNote(vaultPath, "google-chat:users/42", "j3h4b5", {
      status: "pending",
      requestedAt: "2026-07-27T12:20:00Z",
      resolvedAt: null,
      command: "jira issue delete KAN-1 --confirm",
    });

    const log = await gitLog(vaultPath);
    expect(log[0]).toContain("j3h4b5");
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  it("rejects a token containing a path separator", async () => {
    const vaultPath = await makeTempVault();
    await expect(
      writeConfirmationNote(vaultPath, "google-chat:users/42", "../../evil", {
        status: "pending",
        requestedAt: "2026-07-27T12:20:00Z",
        resolvedAt: null,
        command: "jira issue delete KAN-1 --confirm",
      }),
    ).rejects.toThrow();
  });
});

// git add/commit against the same repo aren't safe
// to run concurrently (index lock races). Every writer shares one vault,
// so this must hold across different writer functions, not just repeated
// calls to the same one.
describe("concurrent writes", () => {
  // Found by hand: only git add/commit went through the queue, not the
  // preceding writeFile — two writers targeting the SAME path raced
  // directly on disk content (last writeFile wins silently, no error)
  // while the git layer got confused independently (one commit ends up
  // holding the other's content under its own message, the other then
  // fails with "nothing to commit"). Serializing the whole write (file +
  // commit) as one unit makes the outcome deterministic instead: whichever
  // call is processed second cleanly overwrites the first, with its own
  // clean commit — no races, no spurious failures.
  it("serializes same-path writes deterministically instead of racing on disk content", async () => {
    const vaultPath = await makeTempVault();

    const results = await Promise.allSettled([
      writeCuratedNote(vaultPath, "standards/jira-cli.md", {}, "versione A"),
      writeCuratedNote(vaultPath, "standards/jira-cli.md", {}, "versione B"),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const log = await gitLog(vaultPath);
    expect(log.length).toBe(2);
    expect(await gitStatusPorcelain(vaultPath)).toBe("");

    const text = await readFile(join(vaultPath, "curated/standards/jira-cli.md"), "utf-8");
    expect(["versione A", "versione B"].some((v) => text.includes(v))).toBe(true);
  });

  it("serializes concurrent writes across writer functions instead of racing on git", async () => {
    const vaultPath = await makeTempVault();

    await Promise.all([
      writeCuratedNote(vaultPath, "standards/a.md", {}, "a"),
      writeRawEntry(vaultPath, "notes/concurrent.md", "raw note"),
      writeInferredNote(
        vaultPath,
        "static:user-2",
        "topic",
        { confidence: "low", derived_from: ["ep_1"], last_reviewed: null },
        "body",
      ),
    ]);

    const log = await gitLog(vaultPath);
    expect(log.length).toBe(3);
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });

  // Regression: a commit failing after the file already landed on disk
  // (disk full, corrupt repo) used to leave the vault silently drifted from
  // git HEAD — the thrown error reached the caller, but nothing distinguished
  // this "written but uncommitted" state from a generic failure. This
  // covers the dedicated log line; routing it to a human is a separate,
  // not-yet-built escalation path.
  it("logs a dedicated message when the file lands on disk but the commit fails, instead of staying silent", async () => {
    const vaultPath = await makeTempVault();
    await breakCommits(vaultPath);

    const originalConsoleError = console.error;
    const loggedMessages: string[] = [];
    console.error = (msg: unknown) => {
      loggedMessages.push(String(msg));
    };

    try {
      await expect(
        writeCuratedNote(vaultPath, "standards/x.md", { author: "luca" }, "body"),
      ).rejects.toThrow();

      const text = await readFile(join(vaultPath, "curated/standards/x.md"), "utf-8");
      expect(text).toContain("body");
      expect(await gitStatusPorcelain(vaultPath)).toContain("curated/standards/x.md");

      expect(loggedMessages.some((m) => m.includes("curated/standards/x.md"))).toBe(true);
      expect(loggedMessages.some((m) => m.includes("not committed"))).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("serializes concurrent raw writes/deletes alongside a curated write", async () => {
    const vaultPath = await makeTempVault();
    await writeRawEntry(vaultPath, "notes/to-delete.md", "stale");

    await Promise.all([
      writeRawEntry(vaultPath, "notes/new.md", "fresh"),
      deleteRawEntry(vaultPath, "notes/to-delete.md"),
      writeCuratedNote(vaultPath, "standards/b.md", {}, "b"),
    ]);

    const log = await gitLog(vaultPath);
    // 1 (seed write) + 3 (the three concurrent ops)
    expect(log.length).toBe(4);
    expect(await gitStatusPorcelain(vaultPath)).toBe("");
  });
});

// #154: a read-then-write done outside the commit chain lost updates under
// concurrency (two consolidations, two index upserts, two promotions to one
// path). `when` decides on the file's current content inside the chain.
describe("writes guarded by the current content", () => {
  const fields = { confidence: "low" as const, derived_from: ["ep_1"], last_reviewed: null };

  it("hands `when` the current content, or null for a missing file, and skips the write when it says no", async () => {
    const vaultPath = await makeTempVault();
    const seen: Array<string | null> = [];

    const first = await writeToolCorrectionNote(vaultPath, "jira", "select", fields, "first", {
      when: (current) => {
        seen.push(current);
        return true;
      },
    });
    const second = await writeToolCorrectionNote(vaultPath, "jira", "select", fields, "second", {
      when: (current) => {
        seen.push(current);
        return false;
      },
    });

    expect([first, second]).toEqual([true, false]);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toContain("first");
    const text = await readFile(join(vaultPath, "curated/standards/jira-select.md"), "utf-8");
    expect(text).toContain("first");
    expect(await gitLog(vaultPath)).toHaveLength(1);
  });

  it("decides inside the chain: of two concurrent create-only writes to one path, exactly one lands", async () => {
    const vaultPath = await makeTempVault();
    const onlyIfMissing = { when: (current: string | null) => current === null };

    const results = await Promise.all([
      writeCuratedNote(vaultPath, "standards/release.md", {}, "alice's", onlyIfMissing),
      writeCuratedNote(vaultPath, "standards/release.md", {}, "bob's", onlyIfMissing),
    ]);

    expect(results).toEqual([true, false]);
    const text = await readFile(join(vaultPath, "curated/standards/release.md"), "utf-8");
    expect(text).toContain("alice's");
  });

  it("guards inferred notes the same way", async () => {
    const vaultPath = await makeTempVault();
    const written = await writeInferredNote(vaultPath, "static:alice", "editor", fields, "vim", { when: () => false });
    expect(written).toBe(false);
    expect(await gitLog(vaultPath)).toEqual([]);
  });

  it("deleteCuratedEntry keeps the doc when `when` says no", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/keep.md", {}, "body");

    const deleted = await deleteCuratedEntry(vaultPath, "standards/keep.md", { when: (current) => current === "other" });

    expect(deleted).toBe(false);
    expect(await readFile(join(vaultPath, "curated/standards/keep.md"), "utf-8")).toContain("body");
  });

  it("updateIndexFile never loses an entry to a concurrent update", async () => {
    const vaultPath = await makeTempVault();
    const lines = Array.from({ length: 8 }, (_, i) => `- [[doc-${i}]]`);

    await Promise.all(lines.map((line) => updateIndexFile(vaultPath, (current) => `${current}${line}\n`)));

    const text = await readFile(join(vaultPath, "index.md"), "utf-8");
    for (const line of lines) expect(text).toContain(line);
  });

  it("writes leave no temporary file behind", async () => {
    const vaultPath = await makeTempVault();
    await writeCuratedNote(vaultPath, "standards/clean.md", {}, "body");
    expect(await readdir(join(vaultPath, "curated/standards"))).toEqual(["clean.md"]);
  });
});

