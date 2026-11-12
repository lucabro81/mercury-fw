import { describe, expect, it } from "bun:test";
import type { ContextLayer, ContextRequest, Plugin } from "@mercury-fw/plugin-types";
import { createContextAssembler, profileFor, resolveContext } from "./context.ts";
import type { LoadedPlugin } from "../plugins/plugin-loader.ts";
import type { TurnWho } from "../identity/people.ts";

/** A declared plugin and its loaded counterpart, with `context` as its layer. */
function plugin(name: string, context?: ContextLayer): { declared: Plugin; loaded: LoadedPlugin } {
  const declared = { apiVersion: 6, name, description: name } as Plugin;
  return {
    declared,
    loaded: { name, description: name, actsAs: "anyone", skills: [], source: declared, ...(context === undefined ? {} : { context }) },
  };
}

/** A layer of `scope` that records the requests it's built for and returns `blocks`. */
function layer(scope: "session" | "turn", blocks: string[] | (() => Promise<string[] | undefined>), seen: ContextRequest[] = []): ContextLayer {
  return {
    scope,
    build: async (req) => {
      seen.push(req);
      return typeof blocks === "function" ? blocks() : blocks;
    },
  };
}

const alice: TurnWho = { person: { key: "u:alice", roles: ["staff"] }, operator: false };
const paid: TurnWho = { person: { key: "u:bob", roles: ["staff", "paid"] }, operator: false };
const operator: TurnWho = { person: { key: "operator", roles: ["paid"] }, operator: true };
const turn = (input = "hi", sessionKey = "s1") => ({ sessionKey, input, multiUser: false });

describe("resolveContext: the checks at startup", () => {
  it("is nothing for an instance without context", () => {
    expect(resolveContext(undefined, { declared: [], loaded: [], log: () => {} })).toBeUndefined();
  });

  it("stops the start for a layer that points at a plugin not in plugins, naming it", () => {
    const wiki = plugin("wiki", layer("session", []));
    const stray = plugin("stray", layer("turn", []));
    expect(() =>
      resolveContext(
        { profiles: { default: { layers: [wiki.declared, stray.declared], budget: { maxChars: 100 } } } },
        { declared: [wiki.declared], loaded: [wiki.loaded], log: () => {} },
      ),
    ).toThrow('context profile "default" lists the plugin "stray", which isn\'t in plugins');
  });

  it("stops the start for a loaded plugin in layers that adds nothing to the context", () => {
    const jira = plugin("jira");
    expect(() =>
      resolveContext(
        { profiles: { default: { layers: [jira.declared], budget: { maxChars: 100 } } } },
        { declared: [jira.declared], loaded: [jira.loaded], log: () => {} },
      ),
    ).toThrow('context profile "default" lists the plugin "jira", which has no context layer');
  });

  it("stops the start on a budget that isn't a whole number from 0 up", () => {
    const wiki = plugin("wiki", layer("session", []));
    expect(() =>
      resolveContext(
        { profiles: { default: { layers: [wiki.declared], budget: { maxChars: -1 } } } },
        { declared: [wiki.declared], loaded: [wiki.loaded], log: () => {} },
      ),
    ).toThrow('context profile "default": budget.maxChars must be a whole number from 0 up');
  });

  it("skips the layer of a plugin that wasn't loaded, saying so", () => {
    const wiki = plugin("wiki", layer("session", []));
    const rag = plugin("rag", layer("turn", []));
    const logs: string[] = [];
    const resolved = resolveContext(
      { profiles: { default: { layers: [wiki.declared, rag.declared], budget: { maxChars: 100 } } } },
      { declared: [wiki.declared, rag.declared], loaded: [wiki.loaded], log: (m) => void logs.push(m) },
    );
    expect(resolved?.profiles.get("default")?.layers.map((p) => p.name)).toEqual(["wiki"]);
    expect(logs).toEqual(['[context] the plugin "rag" isn\'t loaded: profile "default" goes without its layer']);
  });

  it("warns about a layer a profile will never use: its plugin is kept from every role the profile is assigned to", () => {
    const rag = plugin("rag", layer("turn", []));
    const logs: string[] = [];
    resolveContext(
      {
        profiles: { default: { layers: [], budget: { maxChars: 0 } }, premium: { layers: [rag.declared], budget: { maxChars: 100 } } },
        assign: { premium: ["paid"] },
      },
      { declared: [rag.declared], loaded: [rag.loaded], access: { rag: { roles: ["admin"] } }, log: (m) => void logs.push(m) },
    );
    expect(logs).toEqual(['[context] profile "premium" will never use the layer of "rag": it\'s given to paid, the plugin only to admin']);
  });
});

describe("profileFor", () => {
  const wiki = plugin("wiki", layer("session", []));
  const resolved = resolveContext(
    {
      profiles: {
        default: { layers: [], budget: { maxChars: 0 } },
        premium: { layers: [wiki.declared], budget: { maxChars: 10 } },
        staffPlus: { layers: [wiki.declared], budget: { maxChars: 20 } },
      },
      assign: { premium: ["paid"], staffPlus: ["staff"] },
    },
    { declared: [wiki.declared], loaded: [wiki.loaded], log: () => {} },
  )!;

  it("gives the first profile in assign, as written, that names one of the person's roles", () => {
    expect(profileFor(resolved, paid).name).toBe("premium");
    expect(profileFor(resolved, alice).name).toBe("staffPlus");
  });

  it("gives default to someone no profile is assigned to, and always to the terminal", () => {
    expect(profileFor(resolved, { person: { key: "x", roles: [] }, operator: false }).name).toBe("default");
    expect(profileFor(resolved, operator).name).toBe("default");
  });
});

describe("createContextAssembler", () => {
  /** An assembler over one default profile of `plugins`, every one offered as `as` unless `offered` says otherwise. */
  function assembler(plugins: Array<{ declared: Plugin; loaded: LoadedPlugin }>, maxChars: number, opts: { offered?: string[]; logs?: string[] } = {}) {
    const resolved = resolveContext(
      { profiles: { default: { layers: plugins.map((p) => p.declared), budget: { maxChars } } } },
      { declared: plugins.map((p) => p.declared), loaded: plugins.map((p) => p.loaded), log: () => {} },
    )!;
    return createContextAssembler({
      resolved,
      offered: () =>
        plugins.filter((p) => opts.offered === undefined || opts.offered.includes(p.loaded.name)).map((p) => ({ plugin: p.loaded, as: "person" as const })),
      log: (m) => void opts.logs?.push(m),
    });
  }

  it("builds a session layer once per session, for the system prompt, and a turn layer every turn, in front of the message", async () => {
    const sessionSeen: ContextRequest[] = [];
    const turnSeen: ContextRequest[] = [];
    let n = 0;
    const wiki = plugin("wiki", layer("session", ["index"], sessionSeen));
    const rag = plugin("rag", layer("turn", async () => [`hit ${++n}`], turnSeen));
    const a = assembler([wiki, rag], 1000);

    const first = await a.forTurn(alice, turn("first"));
    const second = await a.forTurn(alice, turn("second"));

    expect([first.system, first.turn]).toEqual(["index", "<context>\nhit 1\n</context>"]);
    expect([second.system, second.turn]).toEqual(["index", "<context>\nhit 2\n</context>"]);
    expect(sessionSeen.map((r) => r.input)).toEqual(["first"]);
    expect(turnSeen.map((r) => r.input)).toEqual(["first", "second"]);
    expect(turnSeen[0]).toEqual({ sessionKey: "s1", person: { key: "u:alice" }, operator: false, as: "person", input: "first", multiUser: false, knobs: {} });
  });

  it("builds the session layers again for a session it forgot (closed), and separately for each session", async () => {
    const seen: ContextRequest[] = [];
    const a = assembler([plugin("wiki", layer("session", ["index"], seen))], 1000);
    await a.forTurn(alice, turn("a", "s1"));
    await a.forTurn(alice, turn("b", "s2"));
    a.forget("s1");
    await a.forTurn(alice, turn("c", "s1"));
    expect(seen.map((r) => `${r.sessionKey}:${r.input}`)).toEqual(["s1:a", "s2:b", "s1:c"]);
  });

  it("fills the budget with whole blocks, session layers first, then turn layers, each in order, and reports what it kept and dropped", async () => {
    const wiki = plugin("wiki", layer("session", ["aaaa", "bbbbbbbb", "cc"])); // 4 + 2 fit in 10, the 8 doesn't
    const rag = plugin("rag", layer("turn", ["dddd", "e"])); // 4 left: dddd fits, e doesn't
    const notes = plugin("notes", layer("turn", ["f"]));
    const result = await assembler([rag, wiki, notes], 10).forTurn(alice, turn());

    expect(result.system).toBe("aaaa\n\ncc");
    expect(result.turn).toBe("<context>\ndddd\n</context>");
    expect(result.event).toEqual({
      profile: "default",
      budget: 10,
      used: 10,
      layers: [
        { plugin: "rag", scope: "turn", chars: 4, blocks: 1, dropped: 1 },
        { plugin: "wiki", scope: "session", chars: 6, blocks: 2, dropped: 1 },
        { plugin: "notes", scope: "turn", chars: 0, blocks: 0, dropped: 1 },
      ],
    });
  });

  it("skips a layer whose plugin isn't offered to the person, and one that fails, logging the failure", async () => {
    const logs: string[] = [];
    const hidden = plugin("hidden", layer("turn", ["secret"]));
    const broken = plugin(
      "broken",
      layer("turn", async () => {
        throw new Error("down");
      }),
    );
    const fine = plugin("fine", layer("turn", ["ok"]));
    const result = await assembler([hidden, broken, fine], 100, { offered: ["broken", "fine"], logs }).forTurn(alice, turn());

    expect(result.turn).toBe("<context>\nok\n</context>");
    expect(result.event.layers).toEqual([
      { plugin: "hidden", scope: "turn", chars: 0, blocks: 0, dropped: 0, skipped: "not-offered" },
      { plugin: "broken", scope: "turn", chars: 0, blocks: 0, dropped: 0, skipped: "failed" },
      { plugin: "fine", scope: "turn", chars: 2, blocks: 1, dropped: 0 },
    ]);
    expect(logs).toEqual(['[context] the layer of "broken" failed, skipped: down']);
  });

  it("adds nothing when the layers have nothing: no system text, no turn text", async () => {
    const result = await assembler([plugin("wiki", layer("session", [])), plugin("rag", layer("turn", async () => undefined))], 100).forTurn(alice, turn());
    expect(result.system).toBeUndefined();
    expect(result.turn).toBeUndefined();
  });
});

describe("context in a shared space (#387)", () => {
  // Regression: session layers were built once per session, under whoever
  // wrote first, and every later sender in a shared space got that text,
  // personal content included.
  it("builds a session's session layers for each person who writes in it, under their own profile and identity", async () => {
    const seen: ContextRequest[] = [];
    const notes = plugin("notes", layer("session", async () => [`notes of ${seen.at(-1)!.person.key}`], seen));
    const resolved = resolveContext(
      {
        profiles: { default: { layers: [], budget: { maxChars: 0 } }, premium: { layers: [notes.declared], budget: { maxChars: 100 } } },
        assign: { premium: ["staff"] },
      },
      { declared: [notes.declared], loaded: [notes.loaded], log: () => {} },
    )!;
    const a = createContextAssembler({ resolved, offered: () => [{ plugin: notes.loaded, as: "person" }], log: () => {} });
    const shared = (input: string) => ({ sessionKey: "space", input, multiUser: true });
    const outsider: TurnWho = { person: { key: "u:carol", roles: [] }, operator: false };

    const fromAlice = await a.forTurn(alice, shared("a1"));
    const fromCarol = await a.forTurn(outsider, shared("c1"));
    const fromAliceAgain = await a.forTurn(alice, shared("a2"));

    expect(fromAlice.system).toBe("notes of u:alice");
    expect(fromCarol.system).toBeUndefined();
    expect(fromCarol.event).toEqual({ profile: "default", budget: 0, used: 0, layers: [] });
    expect(fromAliceAgain.system).toBe("notes of u:alice");
    expect(seen.map((r) => `${r.person.key}:${r.input}`)).toEqual(["u:alice:a1"]);
  });

  it("forgets every person's session layers when the session closes", async () => {
    const seen: ContextRequest[] = [];
    const wiki = plugin("wiki", layer("session", ["index"], seen));
    const resolved = resolveContext(
      { profiles: { default: { layers: [wiki.declared], budget: { maxChars: 100 } } } },
      { declared: [wiki.declared], loaded: [wiki.loaded], log: () => {} },
    )!;
    const a = createContextAssembler({ resolved, offered: () => [{ plugin: wiki.loaded, as: "anyone" }], log: () => {} });
    await a.forTurn(alice, turn("a", "space"));
    await a.forTurn(paid, turn("b", "space"));
    a.forget("space");
    await a.forTurn(alice, turn("c", "space"));
    await a.forTurn(paid, turn("d", "space"));
    expect(seen.map((r) => r.input)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("resolveContext: a plugin listed twice (#387)", () => {
  it("stops the start: its layer would be built and charged twice", () => {
    const wiki = plugin("wiki", layer("session", []));
    expect(() =>
      resolveContext(
        { profiles: { default: { layers: [wiki.declared, wiki.declared], budget: { maxChars: 100 } } } },
        { declared: [wiki.declared], loaded: [wiki.loaded], log: () => {} },
      ),
    ).toThrow('context profile "default" lists the plugin "wiki" twice');
  });
});
