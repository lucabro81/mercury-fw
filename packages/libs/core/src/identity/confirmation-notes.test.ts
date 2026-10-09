import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfirmationStore, createStageConfirmation } from "@mercury-fw/confirm-engine";
import { createTurnRunner } from "../router/turn-runner.ts";
import { bindConfirm } from "./confirm-binding.ts";
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
// and the pending one stayed "pending" forever. Exercised along the real
// path: the turn runner hands buildTools the key staging uses, and the
// channel confirms with the principal through bindConfirm, as compose wires it.
describe("a confirmation's note, staged in a turn then confirmed from the channel", () => {
  for (const principal of [
    { id: "users/42", provider: "google-chat" as const },
    { id: "auth0|x@y", provider: "oidc" as const },
    { id: "alice", provider: "static" as const },
  ]) {
    it(`is one note in the person's area that ends up confirmed, for ${principal.provider} ${principal.id}`, async () => {
      const vaultPath = await mkdtemp(join(tmpdir(), "mercury-confirm-notes-"));
      tempDirs.push(vaultPath);
      await initVault(vaultPath);
      const store = createConfirmationStore();
      const confirmDeps = { store, vaultPath, writeConfirmationNoteFn: writeConfirmationNote };
      let token = "";
      let stage: ReturnType<typeof createStageConfirmation> | undefined;
      const handleTurn = createTurnRunner({
        model: {} as never,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        // What compose's buildTools hands a tool: staging bound to the turn's key.
        buildTools: (sessionKey, key) => {
          stage = createStageConfirmation({ ...confirmDeps, sessionKey, owner: key });
          return {};
        },
        getOrCreateHistory: () => ({ replaceLastAssistantMessage: () => {} }) as never,
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        recordStepFn: () => {},
        // The model's turn: a tool stages an irreversible action.
        runTurnFn: async () => {
          token = await stage!({ describe: "jira issue delete X-1", run: async () => ({ ok: true, data: "done" }) });
          return "staged";
        },
      });
      const sink = {
        onTextChunk: () => {},
        onToolStart: () => {},
        finalize: async () => {},
        dispose: () => {},
      } as never;

      await handleTurn({ channel: "test", multiUser: false, text: "delete X-1", sessionKey: "s", principal, logPrefix: "" }, sink);
      expect(await bindConfirm(confirmDeps).confirm(token, "s", principal)).toBe('Confermato ed eseguito: "done"');

      const notes = await confirmationNotes(vaultPath);
      expect(Object.keys(notes)).toEqual([`users/${encodeURIComponent(userKey(principal))}/confirmations/${token}.md`]);
      expect(Object.values(notes)[0]).toContain("status: confirmed");
    });
  }

  it("refuses the confirmation from someone else in the same session, leaving it pending", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "mercury-confirm-notes-"));
    tempDirs.push(vaultPath);
    await initVault(vaultPath);
    const store = createConfirmationStore();
    const confirmDeps = { store, vaultPath, writeConfirmationNoteFn: writeConfirmationNote };
    const alice = { id: "alice", provider: "static" as const };
    const stage = createStageConfirmation({ ...confirmDeps, sessionKey: "s", owner: userKey(alice) });
    const token = await stage({ describe: "x", run: async () => ({ ok: true, data: "done" }) });

    expect((await bindConfirm(confirmDeps).resolveConfirmation(token, "s", { id: "alice", provider: "oidc" })).status).toBe("not-found");
    expect((await bindConfirm(confirmDeps).resolveConfirmation(token, "s", alice)).status).toBe("ok");
  });

  // #150: a token belongs to the person, as the directory identifies them,
  // and someone the core won't talk to confirms nothing.
  it("resolves a token as the person the caller is identified as, and refuses someone not admitted", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "mercury-confirm-notes-"));
    tempDirs.push(vaultPath);
    await initVault(vaultPath);
    const store = createConfirmationStore();
    const confirmDeps = { store, vaultPath, writeConfirmationNoteFn: writeConfirmationNote };
    const stage = createStageConfirmation({ ...confirmDeps, sessionKey: "s", owner: "people:alice" });
    const token = await stage({ describe: "x", run: async () => ({ ok: true, data: "done" }) });
    const chat = { id: "users/1", provider: "google-chat" as const };

    const refused = bindConfirm(confirmDeps, async () => ({ ok: false, reason: "unknown", message: "Ask for access." }));
    expect(await refused.confirm(token, "s", chat)).toBe("Ask for access.");
    expect((await refused.resolveConfirmation(token, "s", chat)).status).toBe("not-found");

    const asAlice = bindConfirm(confirmDeps, async () => ({ ok: true, operator: false, person: { key: "people:alice", roles: [] } }));
    expect((await asAlice.resolveConfirmation(token, "s", chat)).status).toBe("ok");
  });

  // Regression (#190): confirm refused anyone the core doesn't admit before
  // checking the text was a token at all, so on Google Chat every message
  // from an unknown sender came back as the refusal, and a link code never
  // reached the core. Text that isn't a token isn't confirm's business.
  it("leaves text that isn't a token to the turn, whoever sends it", async () => {
    const store = createConfirmationStore();
    const confirmDeps = { store, vaultPath: "/nowhere", writeConfirmationNoteFn: writeConfirmationNote };
    let asked = 0;
    const refused = bindConfirm(confirmDeps, async () => (asked++, { ok: false, reason: "unknown", message: "Ask for access." }));
    const chat = { id: "users/1", provider: "google-chat" as const };
    expect(await refused.confirm("a1b2-c3d4-e5f6", "s", chat)).toBeNull();
    expect(await refused.confirm("hello", "s", chat)).toBeNull();
    expect((await refused.resolveConfirmation("hello", "s", chat)).status).toBe("not-a-token");
    expect(asked).toBe(0);
  });
});
