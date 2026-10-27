import { describe, expect, it } from "bun:test";
import type { CliResult } from "@mercury-fw/plugin-types";
import {
  confluencePageListExtractor,
  CONFLUENCE_CHILD_PAGES_SELECT,
  CONFLUENCE_PAGE_LIST_SELECT,
} from "./page-list-extractor.ts";

const t = (key: string) => key;
const run = (prefix: string[], result: CliResult) =>
  confluencePageListExtractor({ binary: "confluence", args: [...prefix], prefix }, result, t);
const ok = (data: unknown): CliResult => ({ ok: true, data });

const SEARCH = ["page", "search"];
const CHILDREN = ["page", "children"];

/** A search result as the CLI prints it with CONFLUENCE_PAGE_LIST_SELECT. */
const pageResult = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  content: { id, title, type: "page" },
  excerpt: `about ${title}`,
  link: `https://example.atlassian.net/wiki/spaces/ENG/pages/${id}/${title}`,
  resultGlobalContainer: { title: "Engineering" },
  ...extra,
});

describe("page search", () => {
  it("emits a page-list with one item per page, and counts them", () => {
    const data = { results: [pageResult("1", "Runbook"), pageResult("2", "Deploy")], totalSize: 2 };
    expect(run(SEARCH, ok(data))).toEqual({
      ok: true,
      data: { ...data, pageCount: 2 },
      display: {
        type: "page-list",
        items: [
          { id: "1", title: "Runbook", space: "Engineering", excerpt: "about Runbook", url: "https://example.atlassian.net/wiki/spaces/ENG/pages/1/Runbook" },
          { id: "2", title: "Deploy", space: "Engineering", excerpt: "about Deploy", url: "https://example.atlassian.net/wiki/spaces/ENG/pages/2/Deploy" },
        ],
      },
    });
  });

  it("keeps blog posts, and leaves attachments and results without content out of the list", () => {
    const data = {
      results: [
        pageResult("1", "Runbook"),
        { content: { id: "9", title: "manual.pdf", type: "attachment" }, excerpt: "", resultGlobalContainer: { title: "Engineering" } },
        { ...pageResult("3", "Release notes"), content: { id: "3", title: "Release notes", type: "blogpost" } },
        { resultGlobalContainer: { title: "Engineering" }, excerpt: "a space" },
      ],
    };
    const result = run(SEARCH, ok(data));
    expect(result.ok && result.display?.items.map((item) => (item as { id: string }).id)).toEqual(["1", "3"]);
    expect(result.ok && (result.data as { pageCount: number }).pageCount).toBe(2);
  });

  it("gives null for a missing space, an empty excerpt and a missing link", () => {
    const data = { results: [{ content: { id: "1", title: "Runbook", type: "page" }, excerpt: "" }] };
    const result = run(SEARCH, ok(data));
    expect(result.ok && result.display).toEqual({
      type: "page-list",
      items: [{ id: "1", title: "Runbook", space: null, excerpt: null, url: null }],
    });
  });

  it("emits an empty page-list when nothing matched", () => {
    const data = { results: [], totalSize: 0 };
    expect(run(SEARCH, ok(data))).toEqual({ ok: true, data: { ...data, pageCount: 0 }, display: { type: "page-list", items: [] } });
  });

  it("adds a note naming the select, and no list, when the select pruned a title or a type", () => {
    for (const content of [{ id: "1", type: "page" }, { id: "1", title: "Runbook" }]) {
      const result = run(SEARCH, ok({ results: [{ content }] }));
      expect(result.ok && result.display).toBeUndefined();
      expect(result.ok && (result.data as { formattedListNote: string }).formattedListNote).toContain(CONFLUENCE_PAGE_LIST_SELECT);
    }
  });

  it("adds the note when the result has no results array", () => {
    const result = run(SEARCH, ok({}));
    expect(result).toEqual({ ok: true, data: { formattedListNote: expect.stringContaining(CONFLUENCE_PAGE_LIST_SELECT) } });
  });
});

describe("page children", () => {
  it("emits child-pages, with no url for a child without a link (a folder)", () => {
    const data = {
      results: [
        { id: "10", title: "Operations", type: "page", link: "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=10" },
        { id: "11", title: "Archive", type: "folder" },
      ],
      nextCursor: "abc",
    };
    expect(run(CHILDREN, ok(data))).toEqual({
      ok: true,
      data,
      display: {
        type: "child-pages",
        items: [
          { id: "10", title: "Operations", type: "page", url: "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=10" },
          { id: "11", title: "Archive", type: "folder", url: null },
        ],
      },
    });
  });

  it("gives null for a pruned type, and adds the note when a title is missing", () => {
    expect(run(CHILDREN, ok({ results: [{ id: "10", title: "Operations" }] }))).toEqual({
      ok: true,
      data: { results: [{ id: "10", title: "Operations" }] },
      display: { type: "child-pages", items: [{ id: "10", title: "Operations", type: null, url: null }] },
    });
    const pruned = run(CHILDREN, ok({ results: [{ id: "10" }] }));
    expect(pruned.ok && pruned.display).toBeUndefined();
    expect(pruned.ok && (pruned.data as { formattedListNote: string }).formattedListNote).toContain(CONFLUENCE_CHILD_PAGES_SELECT);
  });

  it("emits an empty child-pages list for a page with no children", () => {
    expect(run(CHILDREN, ok({ results: [] }))).toEqual({ ok: true, data: { results: [] }, display: { type: "child-pages", items: [] } });
  });
});

describe("everything else", () => {
  it("passes other commands, failures and non-object payloads through untouched", () => {
    const page = ok({ title: "Runbook", body: { markdown: { value: "# Runbook" } } });
    expect(run(["page", "get"], page)).toBe(page);
    const failure: CliResult = { ok: false, error: "boom", exitCode: 1 };
    expect(run(SEARCH, failure)).toBe(failure);
    const text = ok("Usage: confluence page search [OPTIONS]");
    expect(run(SEARCH, text)).toBe(text);
    const list = ok([1, 2]);
    expect(run(CHILDREN, list)).toBe(list);
  });
});

describe("the selects", () => {
  it("name every field the lists are built from", () => {
    expect(CONFLUENCE_PAGE_LIST_SELECT).toBe(
      "results.content.id,results.content.title,results.content.type,results.resultGlobalContainer.title,results.excerpt,results.link,totalSize",
    );
    expect(CONFLUENCE_CHILD_PAGES_SELECT).toBe("results.id,results.title,results.type,results.link,nextCursor");
  });
});
