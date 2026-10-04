import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfirmationStore, createStageConfirmation, resolveConfirmation } from "@mercury-fw/confirm-engine";
import { initVault } from "../wiki/vault-init.ts";
import { writeConfirmationNote } from "../wiki/wiki-note.ts";
import { userKey } from "./user-key.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

/** Every confirmation note in the vault, by vault-relative path. */
async function confirmationNotes(vaultPath: string): Promise<Record<string, string>> {
  const notes: Record<string, string> = {};
  for await (const rel of new Bun.Glob("**/*.md").scan({ cwd: vaultPath })) {
    notes[rel] = await Bun.file(join(vaultPath, rel)).text();
  }
  return notes;
}

// Regression: staging was handed an id the turn runner had already encoded,
// and the note writer encoded it again, while resolution passed the raw id
// and got it encoded once. For an id with a reserved character (Google Chat's
// `users/42`) the pending note and the resolved one landed in two folders,
// and the pending one stayed "pending" forever. Both sides now hand the
// engine the same user key, and only the note writer encodes it.
describe("a confirmation's note, staged then resolved", () => {
  for (const id of ["users/42", "auth0|x@y", "alice"]) {
    it(`is one note that ends up confirmed, for the id ${id}`, async () => {
      const vaultPath = await mkdtemp(join(tmpdir(), "mercury-confirm-notes-"));
      tempDirs.push(vaultPath);
      await initVault(vaultPath);
      const store = createConfirmationStore();
      const owner = userKey({ id, provider: "oidc" });
      const stage = createStageConfirmation({
        store,
        sessionKey: "s",
        owner,
        vaultPath,
        writeConfirmationNoteFn: writeConfirmationNote,
      });
      const token = await stage({ describe: "jira issue delete X-1", run: async () => ({ ok: true, data: "done" }) });
      await resolveConfirmation(token, "s", { store, owner, vaultPath, writeConfirmationNoteFn: writeConfirmationNote });

      const notes = await confirmationNotes(vaultPath);
      expect(Object.keys(notes)).toEqual([`users/${encodeURIComponent(owner)}/confirmations/${token}.md`]);
      expect(Object.values(notes)[0]).toContain("status: confirmed");
    });
  }
});
