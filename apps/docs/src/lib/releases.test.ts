import { describe, expect, test } from "bun:test";
import { latestFrameworkVersion, parseReleases, type GithubRelease } from "./releases.ts";

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

  test("null when there's no framework release yet", () => {
    expect(latestFrameworkVersion([])).toBeNull();
  });
});
