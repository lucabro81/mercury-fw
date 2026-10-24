import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTagTimes } from "./site.ts";

describe("readTagTimes", () => {
  let repo: string;
  /** Runs git in the test repository, with `date` as both author and committer date. */
  const git = (date: string, ...args: string[]) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, env });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tag-times-"));
    git("2026-10-24T00:47:00+02:00", "init", "-q");
    writeFileSync(join(repo, "f"), "x");
    git("2026-10-24T00:47:00+02:00", "add", "f");
    git("2026-10-24T00:47:00+02:00", "commit", "-q", "-m", "Release");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // Regression: changeset tag writes annotated tags, dated when they're made,
  // and the framework's v-tag is a lightweight one, dated by its commit: the
  // plugins of a release came out a few seconds newer than the framework.
  test("an annotated and a lightweight tag on one commit get the commit's time", () => {
    git("2026-10-24T00:47:00+02:00", "tag", "v0.59.2");
    git("2026-10-24T00:47:03+02:00", "tag", "-a", "@mercury-fw/plugin-jira@0.8.1", "-m", "@mercury-fw/plugin-jira@0.8.1");
    const times = readTagTimes(repo);
    expect(times.get("v0.59.2")).toBe("2026-10-24T00:47:00+02:00");
    expect(times.get("@mercury-fw/plugin-jira@0.8.1")).toBe("2026-10-24T00:47:00+02:00");
  });

  test("outside a git repository: no times, no throw", () => {
    const empty = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      expect(readTagTimes(empty).size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
