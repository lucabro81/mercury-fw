import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Principal } from "@mercury-fw/channel-types";
import { createConfirmationStore } from "@mercury-fw/confirm-engine";
import { getToolLog, recordStep, resetToolLogForTest } from "../session/tool-log-buffer.ts";
import { createHostReads, type HostReadsDeps } from "./host-reads.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  resetToolLogForTest();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

const alice: Principal = { id: "alice", provider: "static" };
const bob: Principal = { id: "bob", provider: "static" };

type Scroll = { collection: string; params: Record<string, unknown> };

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

/** The reads over `vaultPath`, with a Qdrant fake that records every scroll. */
function reads(vaultPath: string, overrides: Partial<HostReadsDeps> = {}) {
  const scrolls: Scroll[] = [];
  const confirmationStore = createConfirmationStore();
  const deps: HostReadsDeps = {
    vaultPath,
    qdrant: {
      scroll: async (collection: string, params: Record<string, unknown>) => {
        scrolls.push({ collection, params });
        return { points: [], next_page_offset: null };
      },
    } as unknown as HostReadsDeps["qdrant"],
    collections: { verbatim: "verbatim_archive", episodic: "episodic_memory", semanticFacts: "semantic_facts" },
    confirmationStore,
    manifest: () => ({ plugins: [] }),
    health: async () => ({ up: true }),
    ...overrides,
  };
  return { reads: createHostReads(deps), scrolls, confirmationStore };
}

describe("createHostReads", () => {
  it("lists only the caller's own conversations", async () => {
    const { reads: r, scrolls } = reads(await vault());
    await r.conversations(alice, 20);
    expect(scrolls).toEqual([
      {
        collection: "verbatim_archive",
        params: expect.objectContaining({ filter: { must: [{ key: "userId", match: { value: "static:alice" } }] } }),
      },
    ]);
  });

  it("opens a conversation only among the caller's own messages, whatever session key is asked for", async () => {
    const { reads: r, scrolls } = reads(await vault());
    await r.conversation(bob, "alice:c1", 50, "cur");
    expect(scrolls[0]!.params).toMatchObject({
      filter: {
        must: [
          { key: "userId", match: { value: "static:bob" } },
          { key: "sessionKey", match: { value: "alice:c1" } },
        ],
      },
      limit: 50,
      offset: "cur",
    });
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

  it("scrolls only the per-person collections, filtered to the caller; null for any other collection", async () => {
    const { reads: r, scrolls } = reads(await vault());
    for (const collection of ["verbatim_archive", "episodic_memory", "semantic_facts"]) {
      await r.memoryScroll(alice, collection, 10, undefined);
    }
    expect(scrolls.map((s) => [s.collection, s.params.filter])).toEqual(
      ["verbatim_archive", "episodic_memory", "semantic_facts"].map((c) => [
        c,
        { must: [{ key: "userId", match: { value: "static:alice" } }] },
      ]),
    );
    expect(await r.memoryScroll(alice, "tool_corrections", 10, undefined)).toBeNull();
    expect(await r.memoryScroll(alice, "anything_else", 10, undefined)).toBeNull();
    expect(scrolls).toHaveLength(3);
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

    expect((r.pendingConfirmations(alice) as Array<{ summary: string }>).map((p) => p.summary)).toEqual(["alice's"]);
    expect((r.toolLog(alice) as ReturnType<typeof getToolLog>).map((e) => e.toolName)).toEqual(["alice_tool"]);
  });

  it("keeps the manifest and health global", async () => {
    const { reads: r } = reads(await vault());
    expect(r.manifest()).toEqual({ plugins: [] });
    expect(await r.health()).toEqual({ up: true });
  });
});
