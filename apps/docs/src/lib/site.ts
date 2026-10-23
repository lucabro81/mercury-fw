/**
 * Facts the whole site shows: where the repository is, and which framework
 * version these pages describe. Read once per build and shared by every page.
 */
import { execFileSync } from "node:child_process";
import { fetchReleases, footerVersion, parseTagDates, type Release } from "./releases.ts";
import corePackage from "../../../../packages/libs/core/package.json" with { type: "json" };

export const REPO = "lucabro81/mercury-fw";
export const REPO_URL = `https://github.com/${REPO}`;

let releases: Promise<Release[]> | undefined;

/** Each tag's date, from the git of the repository the build runs in; none
 * when git can't read them (a checkout without tags dates releases by
 * `published_at`). */
function tagDates(): Map<string, string> {
  try {
    const out = execFileSync("git", ["for-each-ref", "refs/tags", "--format=%(refname:short) %(creatordate:iso-strict)"], {
      encoding: "utf-8",
    });
    return parseTagDates(out);
  } catch {
    return new Map();
  }
}

/** The repository's releases, fetched once per build; `RELEASES_REQUIRED=1` makes a failure stop the build. */
export function getReleases(): Promise<Release[]> {
  releases ??= fetchReleases(REPO, {
    fetch,
    token: process.env.GITHUB_TOKEN,
    required: process.env.RELEASES_REQUIRED === "1",
    tagDates: tagDates(),
  });
  return releases;
}

/**
 * The framework version the footer shows, and where it links: the newest
 * framework release and its changelog entry, or the core's own version and the
 * changelog page while there's no release to read (offline, or before the
 * first one), which matches it right after a release anyway.
 */
export async function frameworkVersion(): Promise<{ version: string; href: string }> {
  return footerVersion(await getReleases(), corePackage.version);
}
