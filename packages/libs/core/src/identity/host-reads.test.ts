import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Principal } from "@mercury-fw/channel-types";
import { createConfirmationStore } from "@mercury-fw/confirm-engine";
import { getToolLog, recordStep, resetToolLogForTest } from "../session/tool-log-buffer.ts";
import { fakeVectorIndex } from "../memory/__fixtures__/fake-vector-index.ts";
import { fakeConversationStore } from "../memory/__fixtures__/fake-conversation-store.ts";
import { createHostReads, type HostReadsDeps } from "./host-reads.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  resetToolLogForTest();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

const alice: Principal = { id: "alice", provider: "static" };
const bob: Principal = { id: "bob", provider: "static" };


/** A vault with the common area and a note each for Alice and Bob, plus a file outside it. */
async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mercury-host-reads-"));
  tempDirs.push(root);
  const files: Record<string, string> = {
    "vault/curated/team.md": "team: shared",
    "vault/users/static%3Aalice/notes/a.md": "alice: mine",
    "vault/users/static%3Abob/notes/b.md": "bob: mine",
    "outside.md": "outside",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return join(root, "vault");
}

/** The reads over `vaultPath`, with a fake store and a fake index recording what they're asked. */
function reads(vaultPath: string, overrides: Partial<HostReadsDeps> = {}) {
  const store = fakeConversationStore();
  const index = fakeVectorIndex();
  const confirmationStore = createConfirmationStore();
  const deps: HostReadsDeps = {
    vaultPath,
    store,
    index,
    confirmationStore,
    manifest: () => ({ plugins: [] }),
    health: async () => ({ up: true }),
    ...overrides,
  };
  return { reads: createHostReads(deps), store, index, confirmationStore };
}

describe("createHostReads", () => {
  it("lists only the caller's own conversations", async () => {
    const { reads: r, store } = reads(await vault());
    await r.conversations!(alice, 20);
    expect(store.calls).toEqual([["recent", { userId: "static:alice", limit: 500 }]]);
  });

  it("opens a conversation only among the caller's own messages, whatever session key is asked for", async () => {
    const { reads: r, store } = reads(await vault());
    await r.conversation!(bob, "alice:c1", 50, "cur");
    expect(store.calls[0]).toEqual(["messages", { userId: "static:bob", sessionKey: "alice:c1", order: "asc", limit: 50, cursor: "cur" }]);
  });

  it("shows the wiki as the caller sees it: the common area and their own area, as personal/", async () => {
    const { reads: r } = reads(await vault());
    expect(await r.wikiList(alice)).toEqual(["curated/team.md", "personal/notes/a.md"]);
    expect(await r.wikiRead(alice, "personal/notes/a.md")).toBe("alice: mine");
    expect(await r.wikiGrep(alice, "mine|shared")).toEqual([
      { path: "curated/team.md", line: 1, text: "team: shared" },
      { path: "personal/notes/a.md", line: 1, text: "alice: mine" },
    ]);
  });

  it("answers null for a wiki path outside the caller's scope, the vault's own escapes included", async () => {
    const { reads: r } = reads(await vault());
    for (const path of ["users/static%3Abob/notes/b.md", "personal/../static%3Abob/notes/b.md", "../outside.md", "curated/missing.md"]) {
      expect(await r.wikiRead(alice, path)).toBeNull();
    }
  });

  it("scrolls only the per-person spaces of the vector index, filtered to the caller; null for any other", async () => {
    const { reads: r, index } = reads(await vault());
    index.spaces.set("episodic_memory", [
      { id: "a", vector: [1], payload: { userId: "static:alice", summary: "mine" } },
      { id: "b", vector: [1], payload: { userId: "static:bob", summary: "bob's" } },
    ]);
    for (const space of ["verbatim_archive", "episodic_memory", "semantic_facts"]) {
      await r.memoryScroll!(alice, space, 10, undefined);
    }
    expect(index.calls).toEqual(
      ["verbatim_archive", "episodic_memory", "semantic_facts"].map((space) => ["scroll", space, { where: { userId: "static:alice" }, limit: 10 }]),
    );
    expect(await r.memoryScroll!(alice, "episodic_memory", 10, undefined)).toEqual({
      points: [{ id: "a", payload: { userId: "static:alice", summary: "mine" } }],
      nextOffset: null,
    });
    expect(await r.memoryScroll!(alice, "tool_corrections", 10, undefined)).toBeNull();
    expect(await r.memoryScroll!(alice, "anything_else", 10, undefined)).toBeNull();
  });

  it("pages a space with the cursor the previous page gave", async () => {
    const { reads: r, index } = reads(await vault());
    index.spaces.set(
      "semantic_facts",
      [1, 2, 3].map((n) => ({ id: `f${n}`, vector: [1], payload: { userId: "static:alice", n } })),
    );
    const first = (await r.memoryScroll!(alice, "semantic_facts", 2, undefined)) as { points: unknown[]; nextOffset: string | null };
    expect(first.points).toHaveLength(2);
    expect(first.nextOffset).toBe("2");
    const second = (await r.memoryScroll!(alice, "semantic_facts", 2, first.nextOffset!)) as { points: unknown[]; nextOffset: string | null };
    expect(second).toEqual({ points: [{ id: "f3", payload: { userId: "static:alice", n: 3 } }], nextOffset: null });
  });

  // #379: a read exists only when what it reads does: the conversations with
  // a store, the memory with an index. A channel offers no route for one that's absent.
  it("has no memory read without a vector index, and no conversation reads without a store", async () => {
    const { reads: noIndex } = reads(await vault(), { index: undefined });
    expect(noIndex.memoryScroll).toBeUndefined();
    expect(noIndex.conversations).toBeDefined();
    const { reads: noStore } = reads(await vault(), { store: undefined });
    expect(noStore.conversation).toBeUndefined();
    expect(noStore.conversations).toBeUndefined();
    expect(noStore.memoryScroll).toBeDefined();
  });

  it("lists only the caller's pending confirmations and tool calls", async () => {
    const { reads: r, confirmationStore } = reads(await vault());
    confirmationStore.stage("alice:c1", "static:alice", { describe: "alice's", run: async () => ({ ok: true, data: {} }) });
    confirmationStore.stage("bob:c1", "static:bob", { describe: "bob's", run: async () => ({ ok: true, data: {} }) });
    const call = (name: string) => ({
      toolCalls: [{ toolCallId: "c", toolName: name, input: {} }],
      toolResults: [{ toolCallId: "c", toolName: name, output: {} }],
      content: [],
    });
    recordStep("http", "alice:c1", "static:alice", call("alice_tool"));
    recordStep("http", "bob:c1", "static:bob", call("bob_tool"));

    expect(((await r.pendingConfirmations(alice)) as Array<{ summary: string }>).map((p) => p.summary)).toEqual(["alice's"]);
    expect(((await r.toolLog(alice)) as ReturnType<typeof getToolLog>).map((e) => e.toolName)).toEqual(["alice_tool"]);
  });

  // #150: the manifest shows what the caller is offered, so it's built for them.
  it("builds the manifest for whoever asks, and keeps health global", async () => {
    const { reads: r } = reads(await vault(), { manifest: (who) => ({ for: who.person.key, operator: who.operator }) });
    expect(await r.manifest(alice)).toEqual({ for: "static:alice", operator: false });
    expect(await r.health()).toEqual({ up: true });
  });

  // #150: what's the caller's follows the person the directory says they are.
  it("scopes every read to the person the caller is identified as", async () => {
    const { reads: r, store, confirmationStore } = reads(await vault(), {
      identify: async () => ({ ok: true, operator: false, person: { key: "static:bob", roles: [] } }),
    });
    confirmationStore.stage("bob:c1", "static:bob", { describe: "bob's", run: async () => ({ ok: true, data: {} }) });
    await r.conversations!(alice, 20);
    expect(store.calls[0]).toEqual(["recent", { userId: "static:bob", limit: 500 }]);
    expect(await r.wikiList(alice)).toEqual(["curated/team.md", "personal/notes/b.md"]);
    expect(((await r.pendingConfirmations(alice)) as Array<{ summary: string }>).map((p) => p.summary)).toEqual(["bob's"]);
  });

  // #150: someone the core won't talk to reads nothing, not even the common area.
  it("answers null to every read but health for someone the core doesn't admit", async () => {
    const { reads: r, store, index } = reads(await vault(), {
      identify: async () => ({ ok: false, reason: "unknown", message: "no" }),
    });
    expect(await r.manifest(alice)).toBeNull();
    expect(await r.pendingConfirmations(alice)).toBeNull();
    expect(await r.conversation!(alice, "c", 10)).toBeNull();
    expect(await r.conversations!(alice, 10)).toBeNull();
    expect(await r.wikiList(alice)).toBeNull();
    expect(await r.wikiRead(alice, "curated/team.md")).toBeNull();
    expect(await r.wikiGrep(alice, "team")).toBeNull();
    expect(await r.memoryScroll!(alice, "verbatim_archive", 10)).toBeNull();
    expect(await r.toolLog(alice)).toBeNull();
    expect(store.calls).toEqual([]);
    expect(index.calls).toEqual([]);
    expect(await r.health()).toEqual({ up: true });
  });
});

// #216: a UI asks who the caller is to Mercury, to know whether to let the
// assistant speak first.
describe("createHostReads: me", () => {
  it("answers how the caller asked to be called, the language and the time zone they saved, null for what they never said", async () => {
    const names: Record<string, string> = { "static:alice": "Luca" };
    const languages: Record<string, string> = { "static:alice": "it" };
    const timeZones: Record<string, string> = { "static:alice": "Europe/Rome" };
    const { reads: r } = reads(await vault(), {
      preferredName: (key) => names[key],
      preferredLanguage: (key) => languages[key],
      preferredTimeZone: (key) => timeZones[key],
    });
    expect(await r.me!(alice)).toEqual({ name: "Luca", language: "it", timeZone: "Europe/Rome" });
    expect(await r.me!(bob)).toEqual({ name: null, language: null, timeZone: null });
  });

  it("answers for the person the core identifies, not the raw principal", async () => {
    const { reads: r } = reads(await vault(), {
      preferredName: (key) => (key === "static:bob" ? "Bob" : undefined),
      identify: async () => ({ ok: true, operator: false, person: { key: "static:bob", roles: [] } }),
    });
    expect(await r.me!(alice)).toEqual({ name: "Bob", language: null, timeZone: null });
  });

  it("answers null for someone the core doesn't admit", async () => {
    const { reads: r } = reads(await vault(), {
      preferredName: () => "Luca",
      identify: async () => ({ ok: false, reason: "unknown", message: "no" }),
    });
    expect(await r.me!(alice)).toBeNull();
  });
});

// #214: a conversation is listed and opened with its title, when it has one.
describe("createHostReads: conversation titles", () => {
  const message = (sessionKey: string, content: string, timestamp: string) => ({
    userId: "static:alice",
    sessionKey,
    role: "user",
    content,
    timestamp,
  });

  /** Reads over an archive holding `messages`, with `titlesOf` as given. */
  function withArchive(vaultPath: string, messages: Array<ReturnType<typeof message>>, titlesOf?: HostReadsDeps["titlesOf"]) {
    return createHostReads({
      vaultPath,
      store: fakeConversationStore(messages),
      confirmationStore: createConfirmationStore(),
      manifest: () => ({ plugins: [] }),
      health: async () => ({ up: true }),
      ...(titlesOf === undefined ? {} : { titlesOf }),
    });
  }

  const archive = [message("alice:b", "seconda", "2026-11-05T11:00:00.000Z"), message("alice:a", "prima", "2026-11-05T10:00:00.000Z")];

  it("lists each conversation with its title, asking for the listed ones only, for the caller", async () => {
    const asked: Array<{ userId: string; sessionKeys: string[] }> = [];
    const r = withArchive(await vault(), archive, async (userId, sessionKeys) => {
      asked.push({ userId, sessionKeys });
      return new Map([["alice:a", { title: "Issue aperte", source: "generated" as const }]]);
    });
    expect(await r.conversations!(alice, 20)).toEqual({
      conversations: [
        { sessionKey: "alice:b", lastTimestamp: "2026-11-05T11:00:00.000Z", preview: "seconda" },
        { sessionKey: "alice:a", lastTimestamp: "2026-11-05T10:00:00.000Z", preview: "prima", title: "Issue aperte" },
      ],
    });
    expect(asked).toEqual([{ userId: "static:alice", sessionKeys: ["alice:b", "alice:a"] }]);
  });

  it("lists the conversations without titles when the titles can't be read", async () => {
    const r = withArchive(await vault(), archive, async () => {
      throw new Error("qdrant down");
    });
    expect(await r.conversations!(alice, 20)).toEqual({
      conversations: [
        { sessionKey: "alice:b", lastTimestamp: "2026-11-05T11:00:00.000Z", preview: "seconda" },
        { sessionKey: "alice:a", lastTimestamp: "2026-11-05T10:00:00.000Z", preview: "prima" },
      ],
    });
  });

  it("doesn't ask for titles when there are no conversations", async () => {
    let asked = false;
    const r = withArchive(await vault(), [], async () => {
      asked = true;
      return new Map();
    });
    expect(await r.conversations!(alice, 20)).toEqual({ conversations: [] });
    expect(asked).toBe(false);
  });

  it("opens a conversation with its title", async () => {
    const asked: Array<{ userId: string; sessionKeys: string[] }> = [];
    const r = withArchive(await vault(), [message("alice:a", "prima", "2026-11-05T10:00:00.000Z")], async (userId, sessionKeys) => {
      asked.push({ userId, sessionKeys });
      return new Map([["alice:a", { title: "Le mie issue", source: "person" as const }]]);
    });
    const page = (await r.conversation!(alice, "alice:a", 50)) as { title?: string; messages: unknown[] };
    expect(page.title).toBe("Le mie issue");
    expect(page.messages).toHaveLength(1);
    expect(asked).toEqual([{ userId: "static:alice", sessionKeys: ["alice:a"] }]);
  });

  it("opens a conversation without a title when it has none, or the titles can't be read", async () => {
    const none = withArchive(await vault(), archive, async () => new Map());
    expect(await none.conversation!(alice, "alice:a", 50)).not.toHaveProperty("title");
    const failing = withArchive(await vault(), archive, async () => {
      throw new Error("qdrant down");
    });
    const page = (await failing.conversation!(alice, "alice:a", 50)) as { messages: unknown[] };
    expect(page).not.toHaveProperty("title");
    expect(page.messages).toHaveLength(1);
  });

  it("lists and opens conversations as before on an instance with no titles", async () => {
    const r = withArchive(await vault(), archive);
    const list = (await r.conversations!(alice, 20)) as { conversations: object[] };
    expect(list.conversations.every((c) => !("title" in c))).toBe(true);
    expect(await r.conversation!(alice, "alice:a", 50)).not.toHaveProperty("title");
  });
});
