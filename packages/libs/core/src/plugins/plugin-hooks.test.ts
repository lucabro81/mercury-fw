import { describe, expect, it } from "bun:test";
import type { ClosedSession, FinishedTurn, Plugin } from "@mercury-fw/plugin-types";
import { createPluginHooks } from "./plugin-hooks.ts";
import type { LoadedPlugin } from "./plugin-loader.ts";
import type { TurnWho } from "../identity/people.ts";

/** A loaded plugin with only what the hooks look at. */
function loaded(name: string, hooks: Pick<LoadedPlugin, "afterTurn" | "onSessionClose"> = {}): LoadedPlugin {
  return { name, description: name, actsAs: "anyone", skills: [], source: { name } as Plugin, ...hooks };
}

const alice: TurnWho = { person: { key: "u:alice", roles: ["staff"] }, operator: false };
const info = { sessionKey: "s1", input: "hi", answer: "hello", calls: [], multiUser: false };

/** Lets the hooks' promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createPluginHooks (#387)", () => {
  it("hands a finished turn to the afterTurn of each plugin offered in it, once per plugin, with how it was offered", async () => {
    const seen: Array<[string, FinishedTurn]> = [];
    const jira = loaded("jira", { afterTurn: (t) => void seen.push(["jira", t]) });
    const memo = loaded("memo", { afterTurn: (t) => void seen.push(["memo", t]) });
    const hooks = createPluginHooks({
      // jira offered twice (as the person, and its AsSelf variant): one call, as first offered.
      offered: () => [
        { plugin: jira, as: "person" },
        { plugin: jira, as: "mercury" },
        { plugin: memo, as: "anyone" },
      ],
      log: () => {},
    });

    hooks.afterTurn(alice, info);
    await settle();

    expect(seen).toEqual([
      ["jira", { ...info, person: { key: "u:alice" }, operator: false, as: "person" }],
      ["memo", { ...info, person: { key: "u:alice" }, operator: false, as: "anyone" }],
    ]);
  });

  it("a plugin not offered to the person hears nothing of their turn", async () => {
    const seen: string[] = [];
    const hidden = loaded("hidden", { afterTurn: () => void seen.push("hidden") });
    const hooks = createPluginHooks({ offered: () => [], log: () => {} });
    void hidden;
    hooks.afterTurn(alice, info);
    await settle();
    expect(seen).toEqual([]);
  });

  it("returns before the hooks finish, and a hook that throws or rejects is logged and traced without stopping the others", async () => {
    const logs: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    let release!: () => void;
    const slow = loaded("slow", { afterTurn: () => new Promise<void>((resolve) => (release = resolve)).then(() => void order.push("slow done")) });
    const thrower = loaded("thrower", {
      afterTurn: () => {
        throw new Error("sync broke");
      },
    });
    const rejecter = loaded("rejecter", { afterTurn: async () => Promise.reject(new Error("async broke")) });
    const fine = loaded("fine", { afterTurn: () => void order.push("fine") });
    let clock = 0;
    const hooks = createPluginHooks({
      offered: () => [slow, thrower, rejecter, fine].map((plugin) => ({ plugin, as: "anyone" as const })),
      log: (m) => void logs.push(m),
      emit: (e) => void events.push(e as Record<string, unknown>),
      now: () => (clock += 5),
    });

    hooks.afterTurn(alice, info);
    order.push("returned");
    await settle();
    release();
    await settle();

    expect(order).toEqual(["fine", "returned", "slow done"]);
    expect(logs).toEqual([
      '[hooks] plugin "thrower" afterTurn failed: sync broke',
      '[hooks] plugin "rejecter" afterTurn failed: async broke',
    ]);
    // Each hook's event when it settles: the order between them is the promises'.
    expect(events.map((e) => [e.kind, e.plugin, e.hook, e.outcome, e.session, e.person]).sort()).toEqual([
      ["plugin.hook", "fine", "afterTurn", "done", "s1", "u:alice"],
      ["plugin.hook", "rejecter", "afterTurn", "failed", "s1", "u:alice"],
      ["plugin.hook", "slow", "afterTurn", "done", "s1", "u:alice"],
      ["plugin.hook", "thrower", "afterTurn", "failed", "s1", "u:alice"],
    ]);
    expect(events.at(-1)?.plugin).toBe("slow");
    expect(events.every((e) => typeof e.ms === "number")).toBe(true);
    expect(events.find((e) => e.plugin === "rejecter")?.args).toEqual({ error: "async broke" });
  });

  it("hands a closed session to the onSessionClose of each plugin offered in its last finished turn, with its messages", async () => {
    const seen: Array<[string, ClosedSession]> = [];
    const memo = loaded("memo", { onSessionClose: (s) => void seen.push(["memo", s]) });
    const jira = loaded("jira", { onSessionClose: (s) => void seen.push(["jira", s]) });
    // Offered per role: staff gets memo only, admins get memo and jira.
    const hooks = createPluginHooks({
      offered: (who) => (who.person.roles.includes("admin") ? [memo, jira] : [memo]).map((plugin) => ({ plugin, as: "anyone" as const })),
      log: () => {},
    });

    hooks.afterTurn({ ...alice, person: { ...alice.person, roles: ["admin"] } }, info);
    hooks.afterTurn(alice, info);
    hooks.sessionClosed({
      key: "s1",
      userId: "u:alice",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", calls: [{ toolName: "jira", input: {}, result: { ok: false, ran: "jira", error: "no" } }] },
      ],
    });
    await settle();

    expect(seen).toEqual([
      [
        "memo",
        {
          sessionKey: "s1",
          person: { key: "u:alice" },
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello", calls: [{ toolName: "jira", input: {}, ok: false, error: "no" }] },
          ],
        },
      ],
    ]);
  });

  it("a session closed with no finished turn, or closed twice, reaches no onSessionClose", async () => {
    const seen: string[] = [];
    const memo = loaded("memo", { onSessionClose: () => void seen.push("memo") });
    const hooks = createPluginHooks({ offered: () => [{ plugin: memo, as: "anyone" }], log: () => {} });

    hooks.sessionClosed({ key: "never-answered", userId: "u:alice", messages: [] });
    hooks.afterTurn(alice, info);
    hooks.sessionClosed({ key: "s1", userId: "u:alice", messages: [] });
    hooks.sessionClosed({ key: "s1", userId: "u:alice", messages: [] });
    await settle();

    expect(seen).toEqual(["memo"]);
  });
});

describe("createPluginHooks: the terminal (#387)", () => {
  // The terminal's sessions are never closed by the idle sweep: remembering them would only grow.
  it("hands the operator's turns over without keeping their session for a close", async () => {
    const seen: string[] = [];
    const memo = loaded("memo", { afterTurn: () => void seen.push("turn"), onSessionClose: () => void seen.push("close") });
    const hooks = createPluginHooks({ offered: () => [{ plugin: memo, as: "anyone" }], log: () => {} });
    hooks.afterTurn({ ...alice, operator: true }, info);
    hooks.sessionClosed({ key: "s1", userId: "u:alice", messages: [] });
    await settle();
    expect(seen).toEqual(["turn"]);
  });
});
