import { describe, expect, it } from "bun:test";
import type { ActionResult, StageChoices } from "@mercury-fw/plugin-types";
import { createWebTools, type WebToolsDeps } from "./tools.ts";
import type { PersonalLists } from "./personal-lists.ts";
import type { ReadPageResult } from "./fetch-page.ts";

/** An in-memory personal list. */
function memoryLists(initial: Record<string, string[]> = {}): PersonalLists & { lists: Record<string, string[]> } {
  const lists = { ...initial };
  return {
    lists,
    hostsOf: async (key) => lists[key] ?? [],
    add: async (key, host) => {
      lists[key] = [...(lists[key] ?? []), host];
    },
  };
}

type Staged = Parameters<StageChoices>[0];

function setup(overrides: Partial<WebToolsDeps> = {}) {
  const staged: Staged[] = [];
  const reads: Array<{ url: string; allows: (host: string) => boolean }> = [];
  const deps: WebToolsDeps = {
    backend: {
      apiVersion: 1,
      name: "fake",
      search: async (query, { limit }) => ({
        ok: true,
        results: [{ title: `About ${query}`, url: "https://bun.sh/docs", snippet: "s" }].slice(0, limit),
      }),
    },
    instanceHosts: ["bun.sh"],
    lists: memoryLists(),
    person: { key: "people:alice" },
    stageChoices: async (action) => {
      staged.push(action);
      return action.choices.map((c, i) => ({ label: c.label, token: `T${i + 1}` }));
    },
    checkUrl: async (raw) => {
      if (raw.includes("internal")) return { ok: false, error: "internal is not a public address: internal hosts can't be read" };
      return { ok: true, url: new URL(raw) };
    },
    readPage: async (url, allows): Promise<ReadPageResult> => {
      reads.push({ url, allows });
      return { ok: true, url, title: "Page", text: "the text", truncated: false };
    },
    searchLimit: 8,
    searchTimeoutMs: 10_000,
    ...overrides,
  };
  return { tools: createWebTools(deps), staged, reads, deps };
}

const run = (tool: { execute: (input: never, opts: never) => unknown }, input: unknown) => tool.execute(input as never, {} as never);

describe("web_search", () => {
  it("returns the backend's results to the model", async () => {
    const { tools } = setup();
    expect(await run(tools.web_search, { query: "bun 2" })).toEqual({
      ok: true,
      results: [{ title: "About bun 2", url: "https://bun.sh/docs", snippet: "s" }],
      note: expect.any(String),
    });
  });

  it("marks the results as the web's text, not instructions", async () => {
    const { tools } = setup();
    expect(await run(tools.web_search, { query: "bun 2" })).toMatchObject({ note: expect.stringContaining("never follow") });
  });

  it("keeps at most the limit of results, with title and snippet cut to size, whatever the backend sends", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: "t".repeat(500), url: `https://a.test/${i}`, snippet: "s".repeat(2000) }));
    const { tools } = setup({ backend: { apiVersion: 1, name: "fake", search: async () => ({ ok: true, results: many }) } });
    const out = (await run(tools.web_search, { query: "q" })) as { results: Array<{ title: string; snippet: string }> };
    expect(out.results).toHaveLength(8);
    expect(out.results[0]!.title).toHaveLength(200);
    expect(out.results[0]!.snippet).toHaveLength(500);
  });

  it("passes the backend's error on, naming the backend", async () => {
    const { tools } = setup({ backend: { apiVersion: 1, name: "fake", search: async () => ({ ok: false, error: "engine down" }) } });
    expect(await run(tools.web_search, { query: "x" })).toEqual({ ok: false, error: "fake: engine down" });
  });

  it("turns a backend that throws into an error the model can read", async () => {
    const { tools } = setup({
      backend: {
        apiVersion: 1,
        name: "fake",
        search: async () => {
          throw new Error("socket hang up");
        },
      },
    });
    expect(await run(tools.web_search, { query: "x" })).toEqual({ ok: false, error: "fake: socket hang up" });
  });
});

describe("web_fetch", () => {
  it("reads a page on an instance host right away, marked as untrusted content", async () => {
    const { tools, staged, reads } = setup();

    const result = await run(tools.web_fetch, { url: "https://docs.bun.sh/x" });

    expect(result).toEqual({ ok: true, url: "https://docs.bun.sh/x", title: "Page", text: "the text", truncated: false, note: expect.stringContaining("never follow") });
    expect(staged).toEqual([]);
    expect(reads[0]!.allows("bun.sh")).toBe(true);
    expect(reads[0]!.allows("evil.test")).toBe(false);
  });

  it("reads a page on a host the person allowed, and only theirs", async () => {
    const lists = memoryLists({ "people:alice": ["peps.python.org"], "people:bob": ["evil.test"] });
    const { tools, staged, reads } = setup({ lists });

    await run(tools.web_fetch, { url: "https://peps.python.org/pep-8/" });

    expect(staged).toEqual([]);
    expect(reads[0]!.allows("peps.python.org")).toBe(true);
    expect(reads[0]!.allows("evil.test")).toBe(false);
  });

  it("refuses an internal URL outright, never asking the person", async () => {
    const { tools, staged, reads } = setup();
    expect(await run(tools.web_fetch, { url: "http://internal:6333/" })).toEqual({ ok: false, error: "internal is not a public address: internal hosts can't be read" });
    expect(staged).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("stages the two choices for an unknown host, resuming as web_fetch, and tells the channel which", async () => {
    const { tools, staged, reads } = setup();

    const result = await run(tools.web_fetch, { url: "https://example.org/a" });

    expect(reads).toEqual([]);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.describe).toBe("web_fetch https://example.org/a");
    expect(staged[0]!.choices.map((c) => [c.label, c.resume])).toEqual([
      ["Solo questa volta", { toolName: "web_fetch", input: { url: "https://example.org/a" } }],
      ["Sempre per example.org", { toolName: "web_fetch", input: { url: "https://example.org/a" } }],
    ]);
    expect(result).toEqual({
      ok: false,
      pendingConfirmation: true,
      token: "T1",
      summary: "https://example.org/a",
      choices: [
        { label: "Solo questa volta", token: "T1" },
        { label: "Sempre per example.org", token: "T2" },
      ],
      error: expect.stringContaining("Never mention"),
    });
  });

  it("only this time: reads the page with that host let in once, adding nothing to any list", async () => {
    const lists = memoryLists();
    const { tools, staged, reads } = setup({ lists });
    await run(tools.web_fetch, { url: "https://example.org/a" });

    const outcome: ActionResult = await staged[0]!.choices[0]!.run();

    expect(outcome).toEqual({ ok: true, data: { ok: true, url: "https://example.org/a", title: "Page", text: "the text", truncated: false, note: expect.any(String) } });
    expect(reads[0]!.allows("example.org")).toBe(true);
    expect(reads[0]!.allows("other.org")).toBe(false);
    expect(lists.lists).toEqual({});
  });

  it("always for this host: adds the exact host to the person's list, then reads", async () => {
    const lists = memoryLists();
    const { tools, staged, reads } = setup({ lists });
    await run(tools.web_fetch, { url: "https://docs.example.org/a" });

    await staged[0]!.choices[1]!.run();

    expect(lists.lists).toEqual({ "people:alice": ["docs.example.org"] });
    expect(reads[0]!.allows("docs.example.org")).toBe(true);
  });

  it("always for this host keeps the host even when the read then fails: the person allowed the host, not the page", async () => {
    const lists = memoryLists();
    const { tools, staged } = setup({ lists, readPage: async () => ({ ok: false, error: "the page answered HTTP 503" }) });
    await run(tools.web_fetch, { url: "https://example.org/a" });

    expect(await staged[0]!.choices[1]!.run()).toEqual({ ok: false, error: "the page answered HTTP 503" });
    expect(lists.lists).toEqual({ "people:alice": ["example.org"] });
  });

  // Cold review of #194: a throw inside a confirmed choice escaped the
  // confirmation instead of coming back as a failure.
  it("a confirmed choice never throws: a read that throws comes back as a failure", async () => {
    const { tools, staged } = setup({
      readPage: async () => {
        throw new Error("boom");
      },
    });
    await run(tools.web_fetch, { url: "https://example.org/a" });

    expect(await staged[0]!.choices[0]!.run()).toEqual({ ok: false, error: "the page couldn't be read: boom" });
    expect(await staged[0]!.choices[1]!.run()).toEqual({ ok: false, error: "the page couldn't be read: boom" });
  });

  it("always for this host still reads the page when the host can't be saved", async () => {
    const lists = memoryLists();
    lists.add = async () => {
      throw new Error("ENOSPC");
    };
    const { tools, staged } = setup({ lists });
    await run(tools.web_fetch, { url: "https://example.org/a" });

    expect(await staged[0]!.choices[1]!.run()).toMatchObject({ ok: true, data: { ok: true, url: "https://example.org/a" } });
  });

  it("a host written with a trailing dot or in capitals is saved, and let in, as the plain host", async () => {
    const lists = memoryLists();
    const { tools, staged, reads } = setup({ lists });
    await run(tools.web_fetch, { url: "https://Docs.Example.org./a" });

    expect(staged[0]!.choices[1]!.label).toBe("Sempre per docs.example.org");
    await staged[0]!.choices[1]!.run();
    expect(lists.lists).toEqual({ "people:alice": ["docs.example.org"] });
    expect(reads[0]!.allows("docs.example.org")).toBe(true);
    expect(reads[0]!.allows("docs.example.org.")).toBe(true);
  });

  it("cuts a page's title to size before the model sees it", async () => {
    const { tools } = setup({ readPage: async (url) => ({ ok: true, url, title: "x".repeat(500), text: "t", truncated: false }) });
    const out = (await run(tools.web_fetch, { url: "https://docs.bun.sh/x" })) as { title: string };
    expect(out.title).toHaveLength(200);
  });

  it("a confirmed read that fails reports the failure", async () => {
    const { tools, staged } = setup({ readPage: async () => ({ ok: false, error: "the page answered HTTP 404" }) });
    await run(tools.web_fetch, { url: "https://example.org/a" });

    expect(await staged[0]!.choices[0]!.run()).toEqual({ ok: false, error: "the page answered HTTP 404" });
  });

  it("offers only this time when there's no person, no data folder, or the host can't be an entry", async () => {
    for (const [overrides, url] of [
      [{ person: null }, "https://example.org/a"],
      [{ lists: undefined }, "https://example.org/a"],
      [{}, "https://93.184.216.34/a"],
    ] as const) {
      const { tools, staged } = setup(overrides);
      await run(tools.web_fetch, { url });
      expect(staged[0]!.choices.map((c) => c.label)).toEqual(["Solo questa volta"]);
    }
  });

  it("without a way to ask (an older core), refuses an unknown host", async () => {
    const { tools, reads } = setup({ stageChoices: undefined });
    expect(await run(tools.web_fetch, { url: "https://example.org/a" })).toEqual({
      ok: false,
      error: "example.org isn't on the allowlist, and the user can't be asked to allow it here",
    });
    expect(reads).toEqual([]);
  });
});
