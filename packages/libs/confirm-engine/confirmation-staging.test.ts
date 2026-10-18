import { describe, it, expect } from "bun:test";
import { createStageChoices, createStageConfirmation } from "./confirmation-staging.ts";
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

describe("createStageChoices", () => {
  function deps(writeConfirmationNoteFn: WriteConfirmationNote = noopWrite) {
    let n = 0;
    const store = createConfirmationStore({ tokenFn: () => `T${++n}` });
    return {
      store,
      stage: createStageChoices({
        store,
        sessionKey: "s1",
        owner: OWNER,
        vaultPath: "/vault",
        writeConfirmationNoteFn,
        nowFn: () => new Date("2026-10-18T10:00:00Z"),
      }),
    };
  }

  it("returns a token per choice, in order, with its label, staged as one group", async () => {
    const { store, stage } = deps();
    const once = async () => ({ ok: true as const, data: "once" });
    const always = async () => ({ ok: true as const, data: "always" });
    const resume = { toolName: "web_fetch", input: { url: "https://example.org/a" } };

    const choices = await stage({
      describe: "fetch https://example.org/a",
      choices: [
        { label: "Solo questa volta", run: once, resume },
        { label: "Sempre per example.org", run: always, resume },
      ],
    });

    expect(choices).toEqual([
      { label: "Solo questa volta", token: "T1" },
      { label: "Sempre per example.org", token: "T2" },
    ]);
    const taken = store.take("s1", OWNER, "T2");
    expect(taken?.run).toBe(always);
    expect(taken?.label).toBe("Sempre per example.org");
    expect(taken?.describe).toBe("fetch https://example.org/a");
    expect(taken?.resume).toEqual(resume);
    expect(taken?.requestedAt).toBe("2026-10-18T10:00:00.000Z");
    // the other choice died with it
    expect(store.take("s1", OWNER, "T1")).toBeNull();
  });

  it("writes one pending note for the whole group, under its first token", async () => {
    const writes: Array<{ token: string; fields: unknown }> = [];
    const { stage } = deps(async (_vault, _owner, token, fields) => {
      writes.push({ token, fields });
    });

    await stage({
      describe: "fetch https://example.org/a",
      choices: [
        { label: "Solo questa volta", run: async () => ({ ok: true, data: null }) },
        { label: "Sempre per example.org", run: async () => ({ ok: true, data: null }) },
      ],
    });

    expect(writes).toEqual([
      {
        token: "T1",
        fields: { status: "pending", requestedAt: "2026-10-18T10:00:00.000Z", resolvedAt: null, command: "fetch https://example.org/a" },
      },
    ]);
  });

  it("refuses a group with no choice, staging nothing", async () => {
    const writes: string[] = [];
    const { store, stage } = deps(async (_v, _o, token) => {
      writes.push(token);
    });

    await expect(stage({ describe: "x", choices: [] })).rejects.toThrow("at least one choice");
    expect(writes).toEqual([]);
    expect(store.pending(OWNER)).toEqual([]);
  });

  it("still returns the tokens when the note can't be written", async () => {
    const { stage } = deps(async () => {
      throw new Error("disk full");
    });

    const choices = await stage({ describe: "x", choices: [{ label: "A", run: async () => ({ ok: true, data: null }) }] });

    expect(choices).toEqual([{ label: "A", token: "T1" }]);
  });
});
