/**
 * Facts the whole site shows: where the repository is, and which framework
 * version these pages describe. Read once per build and shared by every page.
 */
import { fetchReleases, latestFrameworkVersion, type Release } from "./releases.ts";
import corePackage from "../../../../packages/libs/core/package.json" with { type: "json" };

export const REPO = "lucabro81/mercury-fw";
export const REPO_URL = `https://github.com/${REPO}`;

let releases: Promise<Release[]> | undefined;

/** The repository's releases, fetched once per build. */
export function getReleases(): Promise<Release[]> {
  releases ??= fetchReleases(REPO);
  return releases;
}

/**
 * The framework version the site describes: the newest framework release, or
 * the core's own version while there's no release to read (offline, or before
 * the first one), which matches it right after a release anyway.
 */
export async function frameworkVersion(): Promise<string> {
  return latestFrameworkVersion(await getReleases()) ?? corePackage.version;
}
