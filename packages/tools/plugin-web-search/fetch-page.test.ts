import { describe, expect, it } from "bun:test";
import { readPage, type ReadPageDeps } from "./fetch-page.ts";

const PUBLIC = "93.184.216.34";
const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

/** A fake web: each URL answers with the given response; requests are recorded. */
function web(pages: Record<string, () => Response>) {
  const requested: Array<{ url: string; redirect?: string }> = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url, redirect: init?.redirect });
    const page = pages[url];
    if (!page) return new Response("not found", { status: 404 });
    return page();
  }) as unknown as typeof fetch;
  return { fetchFn, requested };
}

function deps(fetchFn: typeof fetch, overrides: Partial<ReadPageDeps> = {}): ReadPageDeps {
  return {
    fetch: fetchFn,
    resolve: async (host) => (host === "internal.test" ? ["10.0.0.7"] : [PUBLIC]),
    allowed: () => true,
    maxBytes: 1_000_000,
    maxChars: 100_000,
    timeoutMs: 5_000,
    maxRedirects: 3,
    ...overrides,
  };
}

const page = (body: string, type = "text/html; charset=utf-8") => () => new Response(body, { headers: { "content-type": type } });
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

describe("readPage", () => {
  it("downloads a page with redirects handled by hand, and returns its title and text", async () => {
    const { fetchFn, requested } = web({ "https://a.test/x": page(html("A", "hello there")) });

    const result = await readPage("https://a.test/x", deps(fetchFn));

    expect(result).toEqual({ ok: true, url: "https://a.test/x", title: "A", text: "hello there", truncated: false });
    expect(requested).toEqual([{ url: "https://a.test/x", redirect: "manual" }]);
  });

  it("follows a redirect, relative ones included, and reports the final URL", async () => {
    const { fetchFn } = web({
      "https://a.test/old": redirect("/new", 301),
      "https://a.test/new": redirect("https://b.test/page"),
      "https://b.test/page": page(html("B", "moved here")),
    });

    const result = await readPage("https://a.test/old", deps(fetchFn));

    expect(result).toMatchObject({ ok: true, url: "https://b.test/page", title: "B" });
  });

  it("refuses a redirect to a host that isn't allowed, without downloading it", async () => {
    const { fetchFn, requested } = web({ "https://a.test/x": redirect("https://evil.test/collect"), "https://evil.test/collect": page("x") });

    const result = await readPage("https://a.test/x", deps(fetchFn, { allowed: (host) => host === "a.test" }));

    expect(result).toEqual({ ok: false, error: "the page redirects to evil.test, which isn't allowed" });
    expect(requested.map((r) => r.url)).toEqual(["https://a.test/x"]);
  });

  it("refuses a redirect to an internal address, without downloading it", async () => {
    const { fetchFn, requested } = web({ "https://a.test/x": redirect("http://internal.test/admin") });

    const result = await readPage("https://a.test/x", deps(fetchFn));

    expect(result).toEqual({ ok: false, error: "internal.test is not a public address: internal hosts can't be read" });
    expect(requested).toHaveLength(1);
  });

  it("stops after too many redirects", async () => {
    const { fetchFn } = web({ "https://a.test/1": redirect("/2"), "https://a.test/2": redirect("/3"), "https://a.test/3": redirect("/1") });

    const result = await readPage("https://a.test/1", deps(fetchFn, { maxRedirects: 2 }));

    expect(result).toEqual({ ok: false, error: "too many redirects" });
  });

  it("reports an HTTP error status", async () => {
    const { fetchFn } = web({});
    expect(await readPage("https://a.test/missing", deps(fetchFn))).toEqual({ ok: false, error: "the page answered HTTP 404" });
  });

  it("refuses what isn't a page: images, PDFs, binaries", async () => {
    const { fetchFn } = web({ "https://a.test/file.pdf": page("%PDF", "application/pdf") });
    expect(await readPage("https://a.test/file.pdf", deps(fetchFn))).toEqual({ ok: false, error: "not a page: application/pdf" });
  });

  it("reads plain text", async () => {
    const { fetchFn } = web({ "https://a.test/a.txt": page("just text", "text/plain") });
    expect(await readPage("https://a.test/a.txt", deps(fetchFn))).toMatchObject({ ok: true, text: "just text" });
  });

  it("stops downloading at maxBytes and still reads what it got", async () => {
    const { fetchFn } = web({ "https://a.test/big.txt": page("y".repeat(10_000), "text/plain") });

    const result = await readPage("https://a.test/big.txt", deps(fetchFn, { maxBytes: 100 }));

    expect(result).toMatchObject({ ok: true, text: "y".repeat(100), truncated: true });
  });

  it("a page exactly maxBytes long isn't cut", async () => {
    const { fetchFn } = web({ "https://a.test/exact.txt": page("z".repeat(100), "text/plain") });
    expect(await readPage("https://a.test/exact.txt", deps(fetchFn, { maxBytes: 100 }))).toMatchObject({ ok: true, truncated: false });
  });

  it("reports a download that fails or times out", async () => {
    const failing = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await readPage("https://a.test/slow", deps(failing))).toEqual({ ok: false, error: "the page couldn't be downloaded: The operation timed out." });
  });

  it("checks the very first URL too: an internal one is never requested", async () => {
    const { fetchFn, requested } = web({});
    expect((await readPage("http://internal.test/", deps(fetchFn))).ok).toBe(false);
    expect(requested).toEqual([]);
  });
});
