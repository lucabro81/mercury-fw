import { describe, expect, it } from "bun:test";
import { createConfirmationStore, type ConfirmationStore } from "@mercury-fw/confirm-engine";
import { bindConfirm } from "./confirm-binding.ts";
import { confirmationId } from "../session/turn-trace.ts";
import type { VerbatimExchange } from "../memory/memory-provider.ts";
import type { Identified } from "./people.ts";

const alice = { id: "alice", provider: "static" as const };
const asAlice = async (): Promise<Identified> => ({ ok: true, operator: false, person: { key: "static:alice", roles: [] } });

/** A store whose tokens are `tok1-aaaa`, `tok2-aaaa`, …, and a binding over it that archives into `archived`. */
function setup(opts: { identify?: () => Promise<Identified>; failingArchive?: boolean } = {}) {
  let n = 0;
  const store: ConfirmationStore = createConfirmationStore({ tokenFn: () => `tok${++n}-aaaa` });
  const archived: VerbatimExchange[] = [];
  const bound = bindConfirm(
    { store, vaultPath: "/nowhere", writeConfirmationNoteFn: async () => {}, onResume: () => {} },
    opts.identify ?? asAlice,
    undefined,
    undefined,
    async (msg) => {
      if (opts.failingArchive) throw new Error("qdrant down");
      archived.push(msg);
    },
  );
  return { store, bound, archived };
}

// #370: a conversation reopened later says how each staged action was resolved.
describe("bindConfirm: how a confirmation was resolved, in the archive", () => {
  it("archives the reply to a pasted token, with the staging's id, its command and how it went", async () => {
    const { store, bound, archived } = setup();
    const token = store.stage("s", "static:alice", { describe: "jira issue delete X-1", run: async () => ({ ok: true, data: "done" }) });

    expect(await bound.confirm(token, "s", alice)).toEqual({ text: "Confirmed and done." });

    expect(archived).toEqual([
      {
        sessionKey: "s",
        userId: "static:alice",
        role: "assistant",
        content: "Confirmed and done.",
        confirmation: { id: confirmationId(token), command: "jira issue delete X-1", status: "ok" },
      },
    ]);
  });

  it("archives a choice clicked on a card under the group's first token, naming the choice", async () => {
    const { store, bound, archived } = setup();
    const tokens = store.stageGroup("s", "static:alice", [
      { describe: "fetch https://example.org/a", label: "Only this time", run: async () => ({ ok: true, data: null }) },
      { describe: "fetch https://example.org/a", label: "Always for example.org", run: async () => ({ ok: true, data: null }) },
    ]);

    const outcome = await bound.resolveConfirmation(tokens[1]!, "s", alice);

    expect(outcome.status).toBe("ok");
    expect(archived).toEqual([
      {
        sessionKey: "s",
        userId: "static:alice",
        role: "assistant",
        content: outcome.text!,
        confirmation: { id: confirmationId(tokens[0]!), command: "fetch https://example.org/a", status: "ok", choice: "Always for example.org" },
      },
    ]);
  });

  it("archives a failed action with the reply that said so", async () => {
    const { store, bound, archived } = setup();
    const token = store.stage("s", "static:alice", { describe: "x", run: async () => ({ ok: false, error: "boom" }) });

    const reply = await bound.confirm(token, "s", alice);

    expect(archived).toEqual([
      { sessionKey: "s", userId: "static:alice", role: "assistant", content: reply!.text, confirmation: { id: confirmationId(token), command: "x", status: "failed" } },
    ]);
    expect(reply!.text).toContain("boom");
  });

  it("archives a resumed action with no reply: the resumed turn's answer is what the person gets", async () => {
    const { store, bound, archived } = setup();
    const [token] = store.stageGroup("s", "static:alice", [
      { describe: "fetch https://example.org/a", label: "Only this time", resume: { toolName: "web_fetch", input: {} }, run: async () => ({ ok: true, data: {} }) },
    ]);

    expect(await bound.confirm(token!, "s", alice)).toEqual({ text: expect.any(String), resume: true });

    expect(archived).toEqual([
      {
        sessionKey: "s",
        userId: "static:alice",
        role: "assistant",
        content: "",
        confirmation: { id: confirmationId(token!), command: "fetch https://example.org/a", status: "resume", choice: "Only this time" },
      },
    ]);
  });

  it("archives nothing for text that isn't a token, a token that resolves nothing, or someone not admitted", async () => {
    const { bound, archived } = setup();
    await bound.confirm("hello", "s", alice);
    await bound.confirm("ABCD-EFGH", "s", alice);
    await bound.resolveConfirmation("ABCD-EFGH", "s", alice);

    const refused = setup({ identify: async () => ({ ok: false, reason: "unknown", message: "Ask for access." }) });
    const token = refused.store.stage("s", "static:alice", { describe: "x", run: async () => ({ ok: true, data: null }) });
    await refused.bound.confirm(token, "s", alice);

    expect(archived).toEqual([]);
    expect(refused.archived).toEqual([]);
  });

  // The operator (the terminal) is never tracked: nothing of theirs is archived, as for their turns.
  it("archives nothing for the operator", async () => {
    const { store, bound, archived } = setup({ identify: async () => ({ ok: true, operator: true, person: { key: "operator", roles: [] } }) });
    const token = store.stage("s", "operator", { describe: "x", run: async () => ({ ok: true, data: null }) });

    expect(await bound.confirm(token, "s", alice)).toEqual({ text: "Confirmed and done." });
    expect(archived).toEqual([]);
  });

  it("a failing archive leaves the reply as it was", async () => {
    const { store, bound } = setup({ failingArchive: true });
    const token = store.stage("s", "static:alice", { describe: "x", run: async () => ({ ok: true, data: null }) });

    expect(await bound.confirm(token, "s", alice)).toEqual({ text: "Confirmed and done." });
  });
});
