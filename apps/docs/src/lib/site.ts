/**
 * Facts the whole site shows: where the repository is, and which framework
 * version these pages describe. Read once per build and shared by every page.
 */
import { execFileSync } from "node:child_process";
import { fetchReleases, footerVersion, parseTagTimes, type Release } from "./releases.ts";
import corePackage from "../../../../packages/libs/core/package.json" with { type: "json" };

export const REPO = "lucabro81/mercury-fw";
export const REPO_URL = `https://github.com/${REPO}`;

let releases: Promise<Release[]> | undefined;

/**
 * Each tag's time, as the time of the commit it points to: an annotated tag
 * (what `changeset tag` writes) carries its own date, a lightweight one (the
 * framework's `vX.Y.Z`) its commit's, and a release's tags all point to its
 * release commit. Read from the git of `cwd` (the build's own folder by
 * default); none when git can't read them.
 */
export function readTagTimes(cwd?: string): Map<string, string> {
  try {
    const format = "%(refname:short) %(if)%(*objectname)%(then)%(*committerdate:iso-strict)%(else)%(committerdate:iso-strict)%(end)";
    const out = execFileSync("git", ["for-each-ref", "refs/tags", `--format=${format}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseTagTimes(out);
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
    tagTimes: readTagTimes(),
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
