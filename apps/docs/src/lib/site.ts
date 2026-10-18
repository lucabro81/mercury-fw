/**
 * Facts the whole site shows: where the repository is, and which framework
 * version these pages describe. Read once per build and shared by every page.
 */
import { fetchReleases, footerVersion, type Release } from "./releases.ts";
import corePackage from "../../../../packages/libs/core/package.json" with { type: "json" };

export const REPO = "lucabro81/mercury-fw";
export const REPO_URL = `https://github.com/${REPO}`;

let releases: Promise<Release[]> | undefined;

/** The repository's releases, fetched once per build; `RELEASES_REQUIRED=1` makes a failure stop the build. */
export function getReleases(): Promise<Release[]> {
  releases ??= fetchReleases(REPO, {
    fetch,
    token: process.env.GITHUB_TOKEN,
    required: process.env.RELEASES_REQUIRED === "1",
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
