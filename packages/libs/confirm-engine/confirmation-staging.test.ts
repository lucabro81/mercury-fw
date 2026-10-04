import { describe, it, expect } from "bun:test";
import { createStageConfirmation } from "./confirmation-staging.ts";
import { createConfirmationStore } from "./confirmation-store.ts";
import type { WriteConfirmationNote } from "./confirm-flow.ts";

const OWNER = "google-chat:users/42";

const noopWrite: WriteConfirmationNote = async () => {};

describe("createStageConfirmation", () => {
  it("mints a token via the store, staging the given run thunk and describe", async () => {
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });
    const run = async () => ({ ok: true as const, data: { done: true } });
    const stage = createStageConfirmation({
      store,
      sessionKey: "terminal",
      owner: OWNER,
      vaultPath: "/vault",
      writeConfirmationNoteFn: noopWrite,
    });

    const token = await stage({ run, describe: "jira issue delete KAN-1 --confirm" });

    expect(token).toBe("TOK1");
    const staged = store.take("terminal", OWNER, "TOK1");
    expect(staged?.run).toBe(run);
    expect(staged?.describe).toBe("jira issue delete KAN-1 --confirm");
    expect(staged?.requestedAt).toEqual(expect.any(String));
  });

  it("writes a pending confirmation note keyed by the minted token, with describe as the command", async () => {
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });
    const writes: Array<{ vaultPath: string; owner: string; token: string; fields: unknown }> = [];
    const writeConfirmationNoteFn: WriteConfirmationNote = async (vaultPath, owner, token, fields) => {
      writes.push({ vaultPath, owner, token, fields });
    };
    const stage = createStageConfirmation({
      store,
      sessionKey: "terminal",
      owner: OWNER,
      vaultPath: "/my-vault",
      writeConfirmationNoteFn,
      nowFn: () => new Date("2026-09-18T10:00:00Z"),
    });

    await stage({ run: async () => ({ ok: true, data: {} }), describe: "jira issue delete KAN-1 --confirm" });

    expect(writes).toEqual([
      {
        vaultPath: "/my-vault",
        owner: OWNER,
        token: "TOK1",
        fields: {
          status: "pending",
          requestedAt: "2026-09-18T10:00:00.000Z",
          resolvedAt: null,
          command: "jira issue delete KAN-1 --confirm",
        },
      },
    ]);
  });

  it("still stages and returns the token even if writing the note fails", async () => {
    // A wiki-write failure (disk, git) must never block staging — the user
    // still needs to see and confirm the action; the note is a secondary
    // paper trail, not a precondition.
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });
    const stage = createStageConfirmation({
      store,
      sessionKey: "terminal",
      owner: OWNER,
      vaultPath: "/vault",
      writeConfirmationNoteFn: async () => {
        throw new Error("disk full");
      },
    });

    const token = await stage({ run: async () => ({ ok: true, data: {} }), describe: "jira doctor --confirm" });

    expect(token).toBe("TOK1");
    expect(store.take("terminal", OWNER, "TOK1")?.describe).toBe("jira doctor --confirm");
  });
});
