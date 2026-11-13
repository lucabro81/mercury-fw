import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmationNotesRoot,
  copyVaultConfirmations,
  pendingConfirmationTokens,
  readConfirmationNote,
  writeConfirmationNote,
} from "./confirmation-notes.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-confirmation-notes-"));
  tempDirs.push(dir);
  return dir;
}

const pending = { status: "pending" as const, requestedAt: "2026-11-13T10:00:00.000Z", resolvedAt: null, command: "jira issue delete X-1" };

describe("confirmationNotesRoot", () => {
  it("is the data folder's confirmations/", () => {
    expect(confirmationNotesRoot("/data")).toBe("/data/confirmations");
  });
});

describe("writeConfirmationNote", () => {
  it("writes the note in the person's folder, the key encoded as in the vault, with the confirmation frontmatter", async () => {
    const root = await tempDir();
    await writeConfirmationNote(root, "google-chat:users/42", "ABCD-1234", pending);
    const text = await Bun.file(join(root, "google-chat%3Ausers%2F42", "ABCD-1234.md")).text();
    expect(text).toBe(
      "---\ntype: confirmation\nstatus: pending\nrequested_at: 2026-11-13T10:00:00.000Z\nresolved_at: null\ncommand: jira issue delete X-1\n---\n\n\n",
    );
  });

  it("overwrites the same note when the action is resolved", async () => {
    const root = await tempDir();
    await writeConfirmationNote(root, "static:alice", "T-1", pending);
    await writeConfirmationNote(root, "static:alice", "T-1", { ...pending, status: "confirmed", resolvedAt: "2026-11-13T10:01:00.000Z" });
    const text = await readConfirmationNote(root, "static:alice", "T-1");
    expect(text).toContain("status: confirmed");
    expect(text).toContain("resolved_at: 2026-11-13T10:01:00.000Z");
    expect(await readdir(join(root, "static%3Aalice"))).toEqual(["T-1.md"]);
  });

  it("refuses a token that would leave the person's folder", async () => {
    const root = await tempDir();
    await expect(writeConfirmationNote(root, "static:alice", "../bob/T-1", pending)).rejects.toThrow();
    await expect(writeConfirmationNote(root, "static:alice", "..", pending)).rejects.toThrow();
  });
});

describe("readConfirmationNote", () => {
  it("reads only the person's own note", async () => {
    const root = await tempDir();
    await writeConfirmationNote(root, "static:alice", "T-1", pending);
    await expect(readConfirmationNote(root, "static:bob", "T-1")).rejects.toThrow();
  });

  it("refuses a token with a path in it", async () => {
    const root = await tempDir();
    await expect(readConfirmationNote(root, "static:alice", "../static%3Abob/T-1")).rejects.toThrow();
  });
});

describe("pendingConfirmationTokens", () => {
  it("lists the person's still-pending tokens only", async () => {
    const root = await tempDir();
    await writeConfirmationNote(root, "static:alice", "A-1", pending);
    await writeConfirmationNote(root, "static:alice", "A-2", { ...pending, status: "failed", resolvedAt: pending.requestedAt });
    await writeConfirmationNote(root, "static:alice", "A-3", pending);
    await writeConfirmationNote(root, "static:bob", "B-1", pending);
    expect((await pendingConfirmationTokens(root, "static:alice")).sort()).toEqual(["A-1", "A-3"]);
  });

  it("is empty for someone with no notes, or with a note that isn't one", async () => {
    const root = await tempDir();
    expect(await pendingConfirmationTokens(root, "static:nobody")).toEqual([]);
    await mkdir(join(root, "static%3Aalice"), { recursive: true });
    await writeFile(join(root, "static%3Aalice", "odd.md"), "no frontmatter");
    expect(await pendingConfirmationTokens(root, "static:alice")).toEqual([]);
  });
});

describe("copyVaultConfirmations", () => {
  async function vaultWithNotes(): Promise<string> {
    const vault = await tempDir();
    await mkdir(join(vault, "users", "static%3Aalice", "confirmations"), { recursive: true });
    await mkdir(join(vault, "users", "static%3Abob", "notes"), { recursive: true });
    await writeFile(join(vault, "users", "static%3Aalice", "confirmations", "A-1.md"), "alice's note");
    await writeFile(join(vault, "users", "static%3Abob", "notes", "x.md"), "not a confirmation");
    return vault;
  }

  it("copies every person's confirmation notes from the vault once, leaving the originals", async () => {
    const vault = await vaultWithNotes();
    const root = join(await tempDir(), "confirmations");
    const logs: string[] = [];
    expect(await copyVaultConfirmations({ vaultPath: vault, notesRoot: root, log: (m) => logs.push(m) })).toBe(1);
    expect(await Bun.file(join(root, "static%3Aalice", "A-1.md")).text()).toBe("alice's note");
    expect(await readdir(root)).toEqual(["static%3Aalice"]);
    expect(await Bun.file(join(vault, "users", "static%3Aalice", "confirmations", "A-1.md")).exists()).toBe(true);
    expect(logs).toHaveLength(1);
  });

  it("does nothing once the confirmations folder exists", async () => {
    const vault = await vaultWithNotes();
    const root = join(await tempDir(), "confirmations");
    await mkdir(root);
    expect(await copyVaultConfirmations({ vaultPath: vault, notesRoot: root, log: () => {} })).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("creates the folder, empty, without a vault or with a vault that has no notes", async () => {
    const root = join(await tempDir(), "confirmations");
    expect(await copyVaultConfirmations({ notesRoot: root, log: () => {} })).toBe(0);
    expect(await readdir(root)).toEqual([]);
    const other = join(await tempDir(), "confirmations");
    expect(await copyVaultConfirmations({ vaultPath: await tempDir(), notesRoot: other, log: () => {} })).toBe(0);
    expect(await readdir(other)).toEqual([]);
  });

  it("a copy that fails leaves no folder behind, so the next start tries again", async () => {
    const vault = await vaultWithNotes();
    const root = join(await tempDir(), "confirmations");
    const copy = async () => {
      throw new Error("disk full");
    };
    await expect(copyVaultConfirmations({ vaultPath: vault, notesRoot: root, log: () => {}, copy })).rejects.toThrow("disk full");
    expect(await Bun.file(join(root, "static%3Aalice", "A-1.md")).exists()).toBe(false);
    await expect(readdir(root)).rejects.toThrow();
  });
});
