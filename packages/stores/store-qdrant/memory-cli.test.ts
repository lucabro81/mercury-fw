/**
 * The memory CLI, what `mfw memory` runs in the app's container: lists
 * Qdrant's collections and reads a collection's points, read-only, against a
 * fake client. Output is asserted exactly: it's what a maintainer reads.
 */
import { describe, expect, test } from "bun:test";
import { runMemoryCli, type MemoryCliClient } from "./memory-cli.ts";

type Point = { id: string | number; payload: Record<string, unknown> | null };

/** A fake Qdrant: `collections` by name; `indexed` are the ones with a timestamp
 * index (order_by works), the others reject order_by like Qdrant does. */
function fakeClient(collections: Record<string, Point[]>, indexed: string[] = []) {
  const scrolls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const client: MemoryCliClient = {
    getCollections: async () => ({ collections: Object.keys(collections).map((name) => ({ name })) }),
    count: async (name) => ({ count: collections[name]?.length ?? 0 }),
    scroll: async (name, params) => {
      scrolls.push({ name, params });
      // What the Qdrant client throws when a collection has no index to order by.
      if (params.order_by && !indexed.includes(name)) {
        throw Object.assign(new Error("Bad Request"), {
          status: 400,
          data: { status: { error: "Bad request: No range index for `order_by` key: `timestamp`" } },
        });
      }
      const points = [...(collections[name] ?? [])];
      if (params.order_by) points.sort((a, b) => String(b.payload?.timestamp).localeCompare(String(a.payload?.timestamp)));
      return { points: points.slice(0, params.limit) };
    },
  };
  return { client, scrolls };
}

/** Runs the CLI and collects what it prints to each stream. */
async function run(argv: string[], client: MemoryCliClient) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMemoryCli(argv, { client, out: (l) => void out.push(l), err: (l) => void err.push(l) });
  return { code, out, err };
}

const episodic: Point[] = [
  { id: "a", payload: { userId: "users/1", summary: "Talked about KAN-1", timestamp: "2026-09-01T10:00:00Z" } },
  { id: "b", payload: { userId: "users/1", summary: "Closed KAN-2", timestamp: "2026-09-03T10:00:00Z" } },
  { id: "c", payload: { userId: "users/2", summary: "Asked for PRs", timestamp: "2026-09-02T10:00:00Z" } },
];

describe("list", () => {
  test("every collection with its point count, by name", async () => {
    const { client } = fakeClient({ semantic_facts: [], episodic_memory: episodic });
    const r = await run(["list"], client);
    expect(r).toEqual({ code: 0, out: ["episodic_memory  3 points", "semantic_facts  0 points"], err: [] });
  });

  test("no collections yet", async () => {
    const { client } = fakeClient({});
    expect(await run(["list"], client)).toEqual({ code: 0, out: ["No collections yet."], err: [] });
  });
});

describe("read", () => {
  test("newest first where the collection has a timestamp index, each payload field on its own line", async () => {
    const { client, scrolls } = fakeClient({ episodic_memory: episodic }, ["episodic_memory"]);
    const r = await run(["read", "episodic_memory", "--limit", "2"], client);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "b",
      "  userId: users/1",
      "  summary: Closed KAN-2",
      "  timestamp: 2026-09-03T10:00:00Z",
      "",
      "c",
      "  userId: users/2",
      "  summary: Asked for PRs",
      "  timestamp: 2026-09-02T10:00:00Z",
      "",
    ]);
    expect(r.err).toEqual([]);
    expect(scrolls[0]?.params).toEqual({
      limit: 2,
      with_payload: true,
      order_by: { key: "timestamp", direction: "desc" },
    });
  });

  test("without a timestamp index: Qdrant's own order, and it says so", async () => {
    const facts: Point[] = [{ id: 7, payload: { topic: "editor", value: "vim", tags: ["x"] } }];
    const { client } = fakeClient({ semantic_facts: facts });
    const r = await run(["read", "semantic_facts"], client);
    expect(r.code).toBe(0);
    expect(r.err).toEqual(["semantic_facts has no timestamp index: points in Qdrant's own order."]);
    expect(r.out).toEqual(["7", "  topic: editor", "  value: vim", '  tags: ["x"]', ""]);
  });

  test("20 points by default", async () => {
    const { client, scrolls } = fakeClient({ episodic_memory: episodic }, ["episodic_memory"]);
    await run(["read", "episodic_memory"], client);
    expect(scrolls[0]?.params.limit).toBe(20);
  });

  test("an unknown collection names the existing ones", async () => {
    const { client, scrolls } = fakeClient({ episodic_memory: [] });
    const r = await run(["read", "episodic"], client);
    expect(r).toEqual({ code: 1, out: [], err: ['No collection "episodic". There are: episodic_memory.'] });
    expect(scrolls).toEqual([]);
  });

  test.each([["0"], ["-3"], ["ten"]])("--limit %p is an error", async (limit) => {
    const { client } = fakeClient({ episodic_memory: episodic });
    const r = await run(["read", "episodic_memory", `--limit=${limit}`], client);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`--limit takes a positive whole number (got "${limit}").`]);
  });
});

describe("errors", () => {
  test("Qdrant unreachable: one clear line, exit 1", async () => {
    const client: MemoryCliClient = {
      getCollections: async () => {
        throw new TypeError("fetch failed");
      },
      count: async () => ({ count: 0 }),
      scroll: async () => ({ points: [] }),
    };
    const r = await run(["list"], client);
    expect(r).toEqual({ code: 1, out: [], err: ["Can't reach Qdrant: TypeError: fetch failed"] });
  });

  // Regression: any failure of the ordered read was taken for a missing
  // timestamp index, and a second failure escaped as a stack trace.
  test("a read failing for another reason is an error, not a fallback", async () => {
    const { client, scrolls } = fakeClient({ episodic_memory: episodic }, ["episodic_memory"]);
    client.scroll = async (name, params) => {
      scrolls.push({ name, params });
      throw new TypeError("fetch failed");
    };
    const r = await run(["read", "episodic_memory"], client);
    expect(r).toEqual({ code: 1, out: [], err: ["Qdrant error: TypeError: fetch failed"] });
    expect(scrolls).toHaveLength(1);
  });

  test("the fallback read failing is an error too", async () => {
    const { client } = fakeClient({ semantic_facts: [] });
    const ordered = client.scroll;
    let calls = 0;
    client.scroll = async (name, params) => {
      calls++;
      if (calls === 1) return ordered(name, params);
      throw new TypeError("fetch failed");
    };
    const r = await run(["read", "semantic_facts"], client);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      "semantic_facts has no timestamp index: points in Qdrant's own order.",
      "Qdrant error: TypeError: fetch failed",
    ]);
  });

  test("counting failing in list is an error", async () => {
    const { client } = fakeClient({ episodic_memory: episodic });
    client.count = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await run(["list"], client)).toEqual({ code: 1, out: [], err: ["Qdrant error: TypeError: fetch failed"] });
  });

  test.each([[[]], [["drop"]], [["read"]], [["list", "--limit", "5"]]])("usage %p prints the usage, exit 1", async (argv) => {
    const { client } = fakeClient({});
    const r = await run(argv, client);
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe("Usage: mfw memory <command> [args]");
  });
});
