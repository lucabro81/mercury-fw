import { describe, expect, test } from "bun:test";
import { demoteHeadings, fetchReleases, footerVersion, latestFrameworkVersion, parseReleases, releaseAnchor, type GithubRelease } from "./releases.ts";

const release = (over: Partial<GithubRelease>): GithubRelease => ({
  tag_name: "v0.1.0",
  name: "v0.1.0",
  body: "",
  html_url: "https://github.com/lucabro81/mercury-fw/releases/tag/v0.1.0",
  published_at: "2026-10-01T10:00:00Z",
  draft: false,
  prerelease: false,
  ...over,
});

describe("parseReleases", () => {
  test("a vX.Y.Z tag is a framework release, a <package>@<version> tag a package release", () => {
    const parsed = parseReleases([
      release({ tag_name: "v0.52.0", body: "- Web search", published_at: "2026-10-17T09:00:00Z" }),
      release({ tag_name: "@mercury-fw/plugin-jira@0.6.5", body: "- Fix", published_at: "2026-10-16T09:00:00Z" }),
    ]);
    expect(parsed).toEqual([
      {
        tag: "v0.52.0",
        kind: "framework",
        title: "Mercury Framework 0.52.0",
        package: null,
        version: "0.52.0",
        date: "2026-10-17",
        body: "- Web search",
        url: "https://github.com/lucabro81/mercury-fw/releases/tag/v0.1.0",
        prerelease: false,
      },
      {
        tag: "@mercury-fw/plugin-jira@0.6.5",
        kind: "package",
        title: "@mercury-fw/plugin-jira 0.6.5",
        package: "@mercury-fw/plugin-jira",
        version: "0.6.5",
        date: "2026-10-16",
        body: "- Fix",
        url: "https://github.com/lucabro81/mercury-fw/releases/tag/v0.1.0",
        prerelease: false,
      },
    ]);
  });

  test("newest first, whatever order the API returns", () => {
    const parsed = parseReleases([
      release({ tag_name: "v0.1.0", published_at: "2026-09-01T00:00:00Z" }),
      release({ tag_name: "v0.3.0", published_at: "2026-10-01T00:00:00Z" }),
      release({ tag_name: "v0.2.0", published_at: "2026-09-15T00:00:00Z" }),
    ]);
    expect(parsed.map((r) => r.tag)).toEqual(["v0.3.0", "v0.2.0", "v0.1.0"]);
  });

  test("drafts and tags of another shape are left out", () => {
    const parsed = parseReleases([
      release({ tag_name: "v0.4.0", draft: true }),
      release({ tag_name: "nightly" }),
      release({ tag_name: "v0.3.0" }),
    ]);
    expect(parsed.map((r) => r.tag)).toEqual(["v0.3.0"]);
  });

  test("an unscoped package tag (create-mercury-agent@0.52.0) is a package release", () => {
    const [parsed] = parseReleases([release({ tag_name: "create-mercury-agent@0.52.0" })]);
    expect(parsed?.kind).toBe("package");
    expect(parsed?.package).toBe("create-mercury-agent");
    expect(parsed?.version).toBe("0.52.0");
  });

  test("a release with no body keeps an empty one, never null", () => {
    const [parsed] = parseReleases([release({ body: null })]);
    expect(parsed?.body).toBe("");
  });
});

describe("latestFrameworkVersion", () => {
  test("the newest framework release, skipping newer package releases", () => {
    const parsed = parseReleases([
      release({ tag_name: "@mercury-fw/plugin-jira@0.7.0", published_at: "2026-10-18T00:00:00Z" }),
      release({ tag_name: "v0.52.0", published_at: "2026-10-17T00:00:00Z" }),
      release({ tag_name: "v0.51.0", published_at: "2026-10-10T00:00:00Z" }),
    ]);
    expect(latestFrameworkVersion(parsed)).toBe("0.52.0");
  });

  test("a pre-release is never the version the site describes", () => {
    const parsed = parseReleases([
      release({ tag_name: "v1.0.0-rc.1", prerelease: true, published_at: "2026-10-18T00:00:00Z" }),
      release({ tag_name: "v0.53.0", published_at: "2026-10-17T00:00:00Z" }),
    ]);
    expect(latestFrameworkVersion(parsed)).toBe("0.53.0");
    expect(parsed.map((r) => r.tag)).toEqual(["v1.0.0-rc.1", "v0.53.0"]);
  });

  test("null when there's no framework release yet", () => {
    expect(latestFrameworkVersion([])).toBeNull();
  });
});

describe("fetchReleases", () => {
  const page = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) =>
      release({ tag_name: `v0.${from + i}.0`, published_at: `2026-01-01T00:00:${String((from + i) % 60).padStart(2, "0")}Z` }),
    );

  test("follows the pages until one comes back short, and parses what it got", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      const n = urls.length;
      return new Response(JSON.stringify(n === 1 ? page(100) : page(3, 100)), { status: 200 });
    }) as unknown as typeof fetch;
    const releases = await fetchReleases("owner/repo", { fetch: fetchFn, token: undefined });
    expect(urls).toEqual([
      "https://api.github.com/repos/owner/repo/releases?per_page=100&page=1",
      "https://api.github.com/repos/owner/repo/releases?per_page=100&page=2",
    ]);
    expect(releases).toHaveLength(103);
  });

  test("sends the token when there is one, and no authorization header when there isn't", async () => {
    const seen: Array<string | null> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchReleases("o/r", { fetch: fetchFn, token: "abc" });
    await fetchReleases("o/r", { fetch: fetchFn, token: undefined });
    expect(seen).toEqual(["Bearer abc", null]);
  });

  test("a refused request or a network failure gives an empty list, never a throw", async () => {
    const refused = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchReleases("o/r", { fetch: refused, token: undefined })).toEqual([]);
    expect(await fetchReleases("o/r", { fetch: offline, token: undefined })).toEqual([]);
  });

  test("with RELEASES_REQUIRED set, a failure throws instead, so a published build can't silently lose its changelog", async () => {
    const refused = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchReleases("o/r", { fetch: refused, token: undefined, required: true })).rejects.toThrow("500");
  });
});

describe("releaseAnchor", () => {
  test("a framework release is v<version>, what the footer links to", () => {
    const [r] = parseReleases([release({ tag_name: "v0.52.0" })]);
    expect(releaseAnchor(r!)).toBe("v0.52.0");
  });

  test("a package release keeps name and version, without @ or /", () => {
    const [scoped, plain] = parseReleases([
      release({ tag_name: "@mercury-fw/plugin-jira@0.6.5", published_at: "2026-10-02T00:00:00Z" }),
      release({ tag_name: "create-mercury-agent@0.52.0", published_at: "2026-10-01T00:00:00Z" }),
    ]);
    expect(releaseAnchor(scoped!)).toBe("mercury-fw-plugin-jira-0.6.5");
    expect(releaseAnchor(plain!)).toBe("create-mercury-agent-0.52.0");
  });
});

describe("demoteHeadings", () => {
  test("the body's highest heading becomes an h3 under the release's h2, the rest keep their distance, ids dropped", () => {
    // GitHub's own release notes start at h2 ("What's Changed"): that's the case that must not skip a level.
    expect(demoteHeadings('<h2 id="whats-changed">B</h2><h3>C</h3><h2>D</h2>')).toBe("<h3>B</h3><h4>C</h4><h3>D</h3>");
    expect(demoteHeadings('<h1 id="a">A</h1><h2>B</h2>')).toBe("<h3>A</h3><h4>B</h4>");
  });

  test("never past h6, and the rest of the markup untouched", () => {
    expect(demoteHeadings('<h3>C</h3><h6 class="x">F</h6><p id="keep">p</p>')).toBe('<h3>C</h3><h6 class="x">F</h6><p id="keep">p</p>');
    expect(demoteHeadings('<h1>A</h1><h5>E</h5>')).toBe("<h3>A</h3><h6>E</h6>");
  });

  test("a body without headings comes back as it was", () => {
    expect(demoteHeadings("<ul><li>Fix</li></ul>")).toBe("<ul><li>Fix</li></ul>");
  });
});

describe("footerVersion", () => {
  test("the newest framework release, linked to its entry on the changelog", () => {
    const releases = parseReleases([release({ tag_name: "v0.53.0" })]);
    expect(footerVersion(releases, "0.53.1")).toEqual({ version: "0.53.0", href: "changelog/#v0.53.0" });
  });

  test("with no framework release to read, the core's version and the changelog page itself, never an anchor that isn't there", () => {
    expect(footerVersion([], "0.53.0")).toEqual({ version: "0.53.0", href: "changelog/" });
    const onlyPlugins = parseReleases([release({ tag_name: "@mercury-fw/plugin-jira@0.7.0" })]);
    expect(footerVersion(onlyPlugins, "0.53.0")).toEqual({ version: "0.53.0", href: "changelog/" });
  });
});
