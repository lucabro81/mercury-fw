/**
 * The unified changelog: the repository's GitHub Releases, one per published
 * tag (`vX.Y.Z` for the framework, `<package>@<version>` for a plugin, channel
 * or auth provider), read at build time. The site is built after a release, so
 * what it shows is what is on npm.
 */

/** The fields of a GitHub Release (REST API) this module reads. */
export type GithubRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
};

/** A release as the changelog page shows it. */
export type Release = {
  tag: string;
  kind: "framework" | "package";
  title: string;
  /** The package's name, `null` for a framework release. */
  package: string | null;
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Markdown, as the release carries it. */
  body: string;
  url: string;
};

const FRAMEWORK_TAG = /^v(\d+\.\d+\.\d+.*)$/;
const PACKAGE_TAG = /^((?:@[^/@]+\/)?[^/@]+)@(\d+\.\d+\.\d+.*)$/;

/** Reads one release, or `null` when its tag is neither shape. */
function toRelease(raw: GithubRelease): Release | null {
  const date = (raw.published_at ?? "").slice(0, 10);
  const body = raw.body ?? "";
  const framework = FRAMEWORK_TAG.exec(raw.tag_name);
  if (framework) {
    const version = framework[1]!;
    return { tag: raw.tag_name, kind: "framework", title: `Mercury Framework ${version}`, package: null, version, date, body, url: raw.html_url };
  }
  const pkg = PACKAGE_TAG.exec(raw.tag_name);
  if (pkg) {
    const [, name, version] = pkg as unknown as [string, string, string];
    return { tag: raw.tag_name, kind: "package", title: `${name} ${version}`, package: name, version, date, body, url: raw.html_url };
  }
  return null;
}

/** Published releases with a known tag shape, newest first. */
export function parseReleases(raw: GithubRelease[]): Release[] {
  const byTime = raw
    .filter((r) => !r.draft)
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  return byTime.map(toRelease).filter((r): r is Release => r !== null);
}

/** The newest framework version among `releases` (newest first), or `null`. */
export function latestFrameworkVersion(releases: Release[]): string | null {
  return releases.find((r) => r.kind === "framework")?.version ?? null;
}

/**
 * What the footer shows: the newest framework release, linked to its entry on
 * the changelog (`href` relative to the site's base), or, with no framework
 * release to read, `coreVersion` linked to the changelog page itself.
 */
export function footerVersion(releases: Release[], coreVersion: string): { version: string; href: string } {
  const version = latestFrameworkVersion(releases);
  return version === null ? { version: coreVersion, href: "changelog/" } : { version, href: `changelog/#v${version}` };
}

/** The anchor of a release on the changelog page: `v<version>` for the framework (the footer links to it), the tag without `@` and `/` for a package. */
export function releaseAnchor(r: Release): string {
  return r.kind === "framework" ? `v${r.version}` : r.tag.replace(/[@/]/g, "-").replace(/^-+/, "");
}

/**
 * Puts the headings of a rendered release body below the release's own `h2`
 * (two levels down, never past `h6`) and drops their ids, which would repeat
 * across releases ("What's changed" in every one).
 */
export function demoteHeadings(html: string): string {
  return html.replace(/<(\/?)h([1-6])((?:\s[^>]*)?)>/g, (_, slash: string, level: string, attrs: string) => {
    const to = Math.min(6, Number(level) + 2);
    return `<${slash}h${to}${slash ? "" : attrs.replace(/\s+id="[^"]*"/, "")}>`;
  });
}

/** What `fetchReleases` reads from the world, replaceable in tests. */
export type FetchReleasesDeps = {
  fetch: typeof fetch;
  /** Sent as a bearer token when set (`GITHUB_TOKEN` in CI). */
  token: string | undefined;
  /** Throw on a failure instead of returning no releases: for a build about to be published. */
  required?: boolean;
};

/**
 * Fetches every release of `repo` (`owner/name`) from the GitHub API, page by
 * page. A failure (offline, rate limited) yields an empty list and a warning,
 * and the page then says there's nothing to show yet; with `required` it
 * throws instead.
 */
export async function fetchReleases(repo: string, deps: FetchReleasesDeps): Promise<Release[]> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;
  const all: GithubRelease[] = [];
  try {
    for (let page = 1; ; page++) {
      const res = await deps.fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const batch = (await res.json()) as GithubRelease[];
      all.push(...batch);
      if (batch.length < 100) break;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (deps.required) throw new Error(`releases not read: ${reason}`);
    console.warn(`[docs] releases not read: ${reason}`);
    return [];
  }
  return parseReleases(all);
}
