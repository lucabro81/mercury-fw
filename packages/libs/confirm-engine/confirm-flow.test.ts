import { describe, it, expect } from "bun:test";
import { resolveConfirmation } from "./confirm-flow.ts";
import { createConfirmationStore, type StagedAction } from "./confirmation-store.ts";
import type { WriteConfirmationNote } from "./confirm-flow.ts";

const OWNER = "google-chat:users/42";

const noopWriteConfirmationNoteFn: WriteConfirmationNote = async () => {};

function baseDeps(overrides: Partial<Parameters<typeof resolveConfirmation>[2]> = {}): Parameters<typeof resolveConfirmation>[2] {
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

describe("resolveConfirmation", () => {
  it("says not-a-token for input that isn't a confirm command, never touching the store or running the action", async () => {
    let called = false;
    const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
    store.stage("terminal", OWNER,
      staged("jira issue delete KAN-1 --confirm", async () => {
        called = true;
        return { ok: true, data: {} };
      }),
    );

    const result = await resolveConfirmation("crea un bug su KAN", "terminal", baseDeps({ store }));

    expect(result).toEqual({ status: "not-a-token" });
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

    const result = await resolveConfirmation(token, "terminal", baseDeps({ store }));

    expect(ran).toBe(true);
    expect(result).toEqual({ status: "ok", data: { key: "KAN-1", deleted: true } });
  });

  it("says not-found for an unknown/expired/wrong-session token, never running any action", async () => {
    const result = await resolveConfirmation("ABCD-EFGH", "terminal", baseDeps());

    expect(result).toEqual({ status: "not-found" });
  });

  it("reports failure when the staged action's run fails, still consuming the token", async () => {
    const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
    const token = store.stage("terminal", OWNER,
      staged("jira issue delete KAN-1 --confirm", async () => ({ ok: false, error: "jira exited with code 1: boom" })),
    );

    const result = await resolveConfirmation(token, "terminal", baseDeps({ store }));

    expect(result).toEqual({ status: "failed", error: "jira exited with code 1: boom" });
    // one-shot regardless of outcome: a retry with the same token now finds nothing staged
    const retry = await resolveConfirmation(token, "terminal", baseDeps({ store }));
    expect(retry).toEqual({ status: "not-found" });
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

      await resolveConfirmation(
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

      await resolveConfirmation(token, "terminal", baseDeps({ store, writeConfirmationNoteFn }));

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

      await resolveConfirmation(token, "terminal", baseDeps({ store, writeConfirmationNoteFn }));

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

      const result = await resolveConfirmation(token, "terminal", baseDeps({ store, writeConfirmationNoteFn }));

      expect(result).toEqual({ status: "ok", data: { key: "KAN-1", deleted: true } });
    });
  });
});

describe("a choice of a group", () => {
  it("rewrites the group's note, under its first token, naming the choice taken", async () => {
    let n = 0;
    const store = createConfirmationStore({ tokenFn: () => `abc${++n}-wxyz` });
    store.stageGroup("s1", OWNER, [
      { ...staged("fetch https://example.org/a", async () => ({ ok: true, data: null }), "2026-10-18T10:00:00.000Z"), label: "Solo questa volta" },
      { ...staged("fetch https://example.org/a", async () => ({ ok: true, data: null }), "2026-10-18T10:00:00.000Z"), label: "Sempre per example.org" },
    ]);
    const writes: Array<{ token: string; command: string; status: string }> = [];

    await resolveConfirmation("abc2-wxyz", "s1", baseDeps({
      store,
      writeConfirmationNoteFn: async (_v, _o, token, fields) => {
        writes.push({ token, command: fields.command, status: fields.status });
      },
    }));

    expect(writes).toEqual([{ token: "abc1-wxyz", command: "fetch https://example.org/a — Sempre per example.org", status: "confirmed" }]);
  });
});

describe("resume", () => {
  const resume = { toolName: "web_fetch", input: { url: "https://example.org/a" } };

  function stageResumable(run: StagedAction["run"]) {
    const store = createConfirmationStore({ tokenFn: () => "k9m2-x7q4" });
    store.stageGroup("s1", OWNER, [{ ...staged("fetch https://example.org/a", run), label: "Solo questa volta", resume }]);
    return store;
  }

  it("hands a resumable action's result to onResume and returns the resume outcome, not the result", async () => {
    const store = stageResumable(async () => ({ ok: true, data: { text: "page" } }));
    const resumed: unknown[] = [];

    const outcome = await resolveConfirmation("k9m2-x7q4", "s1", baseDeps({
      store,
      onResume: (sessionKey, action) => resumed.push({ sessionKey, action }),
    }));

    expect(outcome).toEqual({ status: "resume" });
    expect(resumed).toEqual([
      {
        sessionKey: "s1",
        action: {
          describe: "fetch https://example.org/a",
          label: "Solo questa volta",
          toolName: "web_fetch",
          input: { url: "https://example.org/a" },
          output: { text: "page" },
        },
      },
    ]);
  });

  it("a failed resumable action is reported to the person, never resumed", async () => {
    const store = stageResumable(async () => ({ ok: false, error: "timeout" }));
    let resumed = false;

    const outcome = await resolveConfirmation("k9m2-x7q4", "s1", baseDeps({ store, onResume: () => (resumed = true) }));

    expect(outcome).toEqual({ status: "failed", error: "timeout" });
    expect(resumed).toBe(false);
  });

  it("without onResume, a resumable action's result goes to the person as any other", async () => {
    const store = stageResumable(async () => ({ ok: true, data: { text: "page" } }));

    const outcome = await resolveConfirmation("k9m2-x7q4", "s1", baseDeps({ store }));

    expect(outcome).toEqual({ status: "ok", data: { text: "page" } });
  });
});
