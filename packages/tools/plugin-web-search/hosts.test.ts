import { describe, expect, it } from "bun:test";
import { hostAllowed, parseHostEntry } from "./hosts.ts";

describe("parseHostEntry", () => {
  it("normalizes a host: lowercase, no trailing dot", () => {
    expect(parseHostEntry("Docs.Bun.SH.")).toEqual({ ok: true, host: "docs.bun.sh" });
  });

  it("refuses what isn't a bare host: a scheme, a path, a port, a wildcard, spaces", () => {
    for (const entry of ["https://bun.sh", "bun.sh/docs", "bun.sh:443", "*.bun.sh", "bun .sh", "", "user@bun.sh"]) {
      expect(parseHostEntry(entry).ok).toBe(false);
    }
  });

  it("says a URL isn't a host name, not that it's an IP address", () => {
    expect(parseHostEntry("https://x.org")).toEqual({ ok: false, reason: '"https://x.org" is not a host name' });
  });

  it("refuses an IP address: pages are allowed by host name", () => {
    expect(parseHostEntry("93.184.216.34")).toEqual({ ok: false, reason: "93.184.216.34 is an IP address, not a host name" });
    expect(parseHostEntry("[::1]")).toEqual({ ok: false, reason: "[::1] is an IP address, not a host name" });
    expect(parseHostEntry("2606:4700::1111")).toEqual({ ok: false, reason: "2606:4700::1111 is an IP address, not a host name" });
  });

  it("refuses a public suffix, which would let in every site under it", () => {
    for (const entry of ["com", "it", "co.uk", "github.io", "Vercel.App", "pages.dev"]) {
      expect(parseHostEntry(entry)).toEqual({ ok: false, reason: `${entry.toLowerCase()} is a public suffix: it would allow every site under it` });
    }
  });

  it("accepts a site under a public suffix", () => {
    expect(parseHostEntry("bbc.co.uk")).toEqual({ ok: true, host: "bbc.co.uk" });
    expect(parseHostEntry("lucabro81.github.io")).toEqual({ ok: true, host: "lucabro81.github.io" });
  });
});

describe("hostAllowed", () => {
  const entries = ["bun.sh", "docs.python.org"];

  it("allows a listed host and its subdomains", () => {
    expect(hostAllowed("bun.sh", entries)).toBe(true);
    expect(hostAllowed("docs.bun.sh", entries)).toBe(true);
    expect(hostAllowed("a.b.bun.sh", entries)).toBe(true);
    expect(hostAllowed("DOCS.BUN.SH.", entries)).toBe(true);
  });

  it("doesn't allow a parent or a sibling of a listed host", () => {
    expect(hostAllowed("python.org", entries)).toBe(false);
    expect(hostAllowed("wiki.python.org", entries)).toBe(false);
  });

  it("doesn't allow a host that only ends with the same letters", () => {
    expect(hostAllowed("evilbun.sh", entries)).toBe(false);
    expect(hostAllowed("bun.sh.evil.com", entries)).toBe(false);
  });

  it("allows nothing with no entries", () => {
    expect(hostAllowed("bun.sh", [])).toBe(false);
  });
});
