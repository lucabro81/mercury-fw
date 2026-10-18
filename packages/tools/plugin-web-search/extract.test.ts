import { describe, expect, it } from "bun:test";
import { extractText } from "./extract.ts";

const paragraph = (n: number) =>
  `<p>Paragraph ${n} of the article, long enough to count as content, with commas, clauses, and the details a reader came for, explained at length so that it reads like prose.</p>`;

const ARTICLE = `<!doctype html><html><head><title>Bun 2 is out | Bun Blog</title></head><body>
<header><nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a> <a href="/pricing">Pricing</a></nav></header>
<div class="cookie-banner">We use cookies. Accept all cookies?</div>
<main><article><h1>Bun 2 is out</h1>${[1, 2, 3, 4, 5, 6].map(paragraph).join("")}</article></main>
<aside class="sidebar"><h3>Related posts</h3><ul><li><a href="/a">Post A</a></li><li><a href="/b">Post B</a></li></ul></aside>
<footer><a href="/terms">Terms</a> <a href="/privacy">Privacy</a> Copyright Bun</footer>
<script>window.tracking = "never read this";</script>
</body></html>`;

describe("extractText", () => {
  it("keeps the article of a page and drops its menu, footer, sidebar and scripts", () => {
    const page = extractText(ARTICLE, "text/html; charset=utf-8", "https://bun.sh/blog/bun-2", 100_000);

    expect(page.title).toBe("Bun 2 is out | Bun Blog");
    expect(page.text).toContain("Paragraph 1 of the article");
    expect(page.text).toContain("Paragraph 6 of the article");
    expect(page.text).not.toContain("Pricing");
    expect(page.text).not.toContain("Related posts");
    expect(page.text).not.toContain("Privacy");
    expect(page.text).not.toContain("never read this");
    expect(page.truncated).toBe(false);
  });

  it("falls back to the page's whole text, without scripts and styles, when there is no article", () => {
    const index = `<html><head><title>Index</title><style>body{color:red}</style></head><body>
      <ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul><script>var x = "hidden";</script></body></html>`;

    const page = extractText(index, "text/html", "https://example.org/", 100_000);

    expect(page.title).toBe("Index");
    expect(page.text).toContain("Alpha");
    expect(page.text).toContain("Beta");
    expect(page.text).not.toContain("hidden");
    expect(page.text).not.toContain("color:red");
  });

  // Found live on rfc-editor.org: a page with no <html> made linkedom take its
  // first <pre> as the document, leaving the body empty and the text "".
  it("reads a page that is only bare blocks, with no html or body tags, all of it", () => {
    const bare = `<pre>Network Working Group      D. Eastlake
Request for Comments: 2606</pre>
<hr><pre>
1. Introduction

The global Internet Domain Name System is documented in [RFC 1034].</pre>`;

    const page = extractText(bare, "text/html", "https://www.rfc-editor.org/rfc/rfc2606.html", 100_000);

    expect(page.text).toContain("Network Working Group");
    expect(page.text).toContain("The global Internet Domain Name System");
  });

  it("reads a bare page even when a script in it mentions an <html> tag", () => {
    const page = extractText("<p>real text</p><script>var a = '<html >';</script><p>more text</p>", "text/html", "https://x.test/", 100_000);
    expect(page.text).toContain("real text");
    expect(page.text).toContain("more text");
  });

  it("collapses the whitespace of the text", () => {
    const page = extractText("<html><body><p>a\n\n\n   b</p>\n\n\n\n<p>c</p></body></html>", "text/html", "https://example.org/", 100_000);
    expect(page.text).not.toMatch(/\n{3,}/);
    expect(page.text).not.toMatch(/ {2,}/);
  });

  it("returns plain text as it is, titled by its URL", () => {
    const page = extractText("line one\nline two", "text/plain", "https://example.org/notes.txt", 100_000);
    expect(page).toEqual({ title: "https://example.org/notes.txt", text: "line one\nline two", truncated: false });
  });

  it("cuts the text at maxChars and says so", () => {
    const page = extractText("x".repeat(500), "text/plain", "https://example.org/big.txt", 100);
    expect(page.text).toBe("x".repeat(100));
    expect(page.truncated).toBe(true);
  });

  it("titles a page with no title by its URL", () => {
    const page = extractText("<html><body><p>hello</p></body></html>", "text/html", "https://example.org/x", 100_000);
    expect(page.title).toBe("https://example.org/x");
  });
});
