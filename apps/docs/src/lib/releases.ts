/**
 * The unified changelog: the repository's GitHub Releases, one per published
 * tag (`vX.Y.Z` for the framework, `<package>@<version>` for a plugin, channel
 * or auth provider), read at build time. The site is built after a release, so
 * what it shows is what is on npm. Releases are ordered by the commit their
 * tag points to when the build can read it: the Releases of the tags made
 * before Releases existed were all created on one day, long after the tags,
 * and a release's tags all point to its release commit.
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
  /** Markdown, as the release carries it. */
  body: string;
  url: string;
  /** Listed on the changelog, never the version the site describes. */
  prerelease: boolean;
};

const FRAMEWORK_TAG = /^v(\d+\.\d+\.\d+.*)$/;
const PACKAGE_TAG = /^((?:@[^/@]+\/)?[^/@]+)@(\d+\.\d+\.\d+.*)$/;

/** When `raw` happened: its tag's commit time when known (`tagTimes`), else when it was published. */
function when(raw: GithubRelease, tagTimes: Map<string, string>): string {
  return tagTimes.get(raw.tag_name) ?? raw.published_at ?? "";
}

/** Reads one release, or `null` when its tag is neither shape. */
function toRelease(raw: GithubRelease): Release | null {
  const body = raw.body ?? "";
  const framework = FRAMEWORK_TAG.exec(raw.tag_name);
  if (framework) {
    const version = framework[1]!;
    return { tag: raw.tag_name, kind: "framework", title: `Mercury Framework ${version}`, package: null, version, body, url: raw.html_url, prerelease: raw.prerelease };
  }
  const pkg = PACKAGE_TAG.exec(raw.tag_name);
  if (pkg) {
    const [, name, version] = pkg as unknown as [string, string, string];
    return { tag: raw.tag_name, kind: "package", title: `${name} ${version}`, package: name, version, body, url: raw.html_url, prerelease: raw.prerelease };
  }
  return null;
}

/**
 * Published releases with a known tag shape, newest first. `tagTimes` maps a
 * tag to the time of the commit it points to (ISO 8601, as `parseTagTimes`
 * reads them); a release whose tag isn't there goes by `published_at`. The
 * releases of one commit come framework first, then the packages by name.
 */
export function parseReleases(raw: GithubRelease[], tagTimes: Map<string, string> = new Map()): Release[] {
  const time = (r: GithubRelease) => Date.parse(when(r, tagTimes)) || 0;
  const published = (r: GithubRelease) => Date.parse(r.published_at ?? "") || 0;
  const releases = raw
    .filter((r) => !r.draft)
    .map((r) => ({ raw: r, release: toRelease(r) }))
    .filter((x): x is { raw: GithubRelease; release: Release } => x.release !== null);
  releases.sort(
    (a, b) =>
      time(b.raw) - time(a.raw) ||
      (a.release.kind === b.release.kind ? 0 : a.release.kind === "framework" ? -1 : 1) ||
      (a.release.package ?? "").localeCompare(b.release.package ?? "") ||
      published(b.raw) - published(a.raw),
  );
  return releases.map((x) => x.release);
}

/** The tags' commit times from `git for-each-ref`, one `<tag> <time>` per line (`readTagTimes` in site.ts). */
export function parseTagTimes(output: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [tag, date] = line.trim().split(" ");
    if (tag && date) dates.set(tag, date);
  }
  return dates;
}

/** The newest framework version among `releases` (newest first), pre-releases left out, or `null`. */
export function latestFrameworkVersion(releases: Release[]): string | null {
  return releases.find((r) => r.kind === "framework" && !r.prerelease)?.version ?? null;
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
 * Puts the headings of a rendered release body below the release's own `h2`:
 * the body's highest heading becomes an `h3` and the others keep their
 * distance from it (never past `h6`), so no level is skipped. Their ids go,
 * since they'd repeat across releases ("What's changed" in every one).
 */
export function demoteHeadings(html: string): string {
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  if (levels.length === 0) return html;
  const shift = 3 - Math.min(...levels);
  return html.replace(/<(\/?)h([1-6])((?:\s[^>]*)?)>/g, (_, slash: string, level: string, attrs: string) => {
    const to = Math.min(6, Math.max(3, Number(level) + shift));
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
  /** Each tag's commit time (`parseTagTimes`), which orders a release before its `published_at`. */
  tagTimes?: Map<string, string>;
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
  return parseReleases(all, deps.tagTimes);
}
