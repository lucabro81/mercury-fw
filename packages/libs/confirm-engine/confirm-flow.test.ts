import { describe, it, expect } from "bun:test";
import { tryConfirm } from "./confirm-flow.ts";
import { createConfirmationStore, type StagedAction } from "./confirmation-store.ts";
import type { WriteConfirmationNote } from "./confirm-flow.ts";

const OWNER = "google-chat:users/42";

const noopWriteConfirmationNoteFn: WriteConfirmationNote = async () => {};

function baseDeps(overrides: Partial<Parameters<typeof tryConfirm>[2]> = {}): Parameters<typeof tryConfirm>[2] {
  return {
    store: createConfirmationStore(),
    owner: OWNER,
    vaultPath: "/vault",
    writeConfirmationNoteFn: noopWriteConfirmationNoteFn,
    ...overrides,
  };
}

// A staged action is an opaque thunk + describe; these build one whose run
// resolves to a fixed result, standing in for what the CLI tool stages.
function staged(describe: string, run: StagedAction["run"], requestedAt?: string): StagedAction {
  return { run, describe, requestedAt };
}

describe("tryConfirm", () => {
  it("returns null for input that isn't a confirm command, never touching the store or running the action", async () => {
    let called = false;
    const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
    store.stage("terminal", OWNER,
      staged("jira issue delete KAN-1 --confirm", async () => {
        called = true;
        return { ok: true, data: {} };
      }),
    );

    const result = await tryConfirm("crea un bug su KAN", "terminal", baseDeps({ store }));

    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("runs the staged action for a valid token and reports success", async () => {
    const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
    let ran = false;
    const token = store.stage("terminal", OWNER,
      staged("jira issue delete KAN-1 --confirm", async () => {
        ran = true;
        return { ok: true, data: { key: "KAN-1", deleted: true } };
      }),
    );

    const result = await tryConfirm(token, "terminal", baseDeps({ store }));

    expect(ran).toBe(true);
    expect(result).not.toBeNull();
    expect(result).toContain("KAN-1");
  });

  it("returns a canned message for an unknown/expired/wrong-session token, never running any action", async () => {
    const result = await tryConfirm("ABCD-EFGH", "terminal", baseDeps());

    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain("nessuna conferma");
  });

  it("reports failure when the staged action's run fails, still consuming the token", async () => {
    const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
    const token = store.stage("terminal", OWNER,
      staged("jira issue delete KAN-1 --confirm", async () => ({ ok: false, error: "jira exited with code 1: boom" })),
    );

    const result = await tryConfirm(token, "terminal", baseDeps({ store }));

    expect(result).toContain("boom");
    // one-shot regardless of outcome: a retry with the same token now finds nothing staged
    const retry = await tryConfirm(token, "terminal", baseDeps({ store }));
    expect(retry?.toLowerCase()).toContain("nessuna conferma");
  });

  // Regression guard for the stale-primer bug: the resolve half of a
  // confirm-required action must overwrite the same deterministic note the
  // propose half wrote, so the persistent record never gets stuck saying
  // "pending" for an action that was actually confirmed or abandoned.
  describe("confirmation note (resolve side)", () => {
    it("overwrites the note as confirmed on a successful run, using the action's describe as the command", async () => {
      const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
      const token = store.stage("terminal", OWNER,
        staged(
          "jira issue delete KAN-1 --confirm",
          async () => ({ ok: true, data: { deleted: true } }),
          "2026-07-27T12:20:00.000Z",
        ),
      );
      const writes: unknown[] = [];
      const writeConfirmationNoteFn: WriteConfirmationNote = async (vaultPath, owner, tok, fields) => {
        writes.push({ vaultPath, owner, tok, fields });
      };

      await tryConfirm(
        token,
        "terminal",
        baseDeps({ store, writeConfirmationNoteFn, now: () => new Date("2026-07-27T12:25:00Z") }),
      );

      expect(writes).toEqual([
        {
          vaultPath: "/vault",
          owner: OWNER,
          tok: "k9m2-x7q4",
          fields: {
            status: "confirmed",
            requestedAt: "2026-07-27T12:20:00.000Z",
            resolvedAt: "2026-07-27T12:25:00.000Z",
            command: "jira issue delete KAN-1 --confirm",
          },
        },
      ]);
    });

    it("overwrites the note as failed when the run fails", async () => {
      const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
      const token = store.stage("terminal", OWNER,
        staged("jira issue delete KAN-1 --confirm", async () => ({ ok: false, error: "boom" }), "2026-07-27T12:20:00.000Z"),
      );
      const writes: unknown[] = [];
      const writeConfirmationNoteFn: WriteConfirmationNote = async (vaultPath, owner, tok, fields) => {
        writes.push({ vaultPath, owner, tok, fields });
      };

      await tryConfirm(token, "terminal", baseDeps({ store, writeConfirmationNoteFn }));

      expect(writes).toEqual([
        { vaultPath: "/vault", owner: OWNER, tok: "k9m2-x7q4", fields: expect.objectContaining({ status: "failed" }) },
      ]);
    });

    it("falls back gracefully when the staged action has no requestedAt (older/test-constructed entries)", async () => {
      const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
      const token = store.stage("terminal", OWNER, staged("jira issue delete KAN-1 --confirm", async () => ({ ok: true, data: {} })));
      const writes: unknown[] = [];
      const writeConfirmationNoteFn: WriteConfirmationNote = async (_v, _u, _t, fields) => {
        writes.push(fields);
      };

      await tryConfirm(token, "terminal", baseDeps({ store, writeConfirmationNoteFn }));

      expect(writes).toEqual([expect.objectContaining({ requestedAt: expect.any(String) })]);
    });

    it("a wiki-write failure does not break the confirm/execute flow itself", async () => {
      const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
      const token = store.stage("terminal", OWNER,
        staged("jira issue delete KAN-1 --confirm", async () => ({ ok: true, data: { key: "KAN-1", deleted: true } })),
      );
      const writeConfirmationNoteFn: WriteConfirmationNote = async () => {
        throw new Error("disk full");
      };

      const result = await tryConfirm(token, "terminal", baseDeps({ store, writeConfirmationNoteFn }));

      expect(result).toContain("KAN-1");
    });
  });
});
