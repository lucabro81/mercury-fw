import { describe, it, expect } from "bun:test";
import { createJiraIssueListExtractor, JIRA_ISSUE_LIST_SELECT } from "./index.ts";
import type { CliResult } from "@mercury-fw/cli-engine";

/**
 * Integration-shaped test of the real `@mercury-fw/plugin-jira` issue-list
 * extractor. It emits **structured records** on the user-facing `display`
 * channel — one `{ key, status, summary, url }` per issue, never a rendered
 * string; turning those into text is the composition render handler's job (see
 * its own tests in @mercury-fw/core). These assertions cover extraction and its
 * defensive shape handling, plus the plugin-owned config schema.
 */
const SITE_URL = "https://example.atlassian.net";
const PARSED = { binary: "jira", args: ["issue", "search"], prefix: ["issue", "search"] };

describe("createJiraIssueListExtractor", () => {
  const extract = createJiraIssueListExtractor({ siteUrl: SITE_URL });

  // The allowlist no longer names a post-processor per command: the plugin's
  // single post-processor runs on every allowed command and must leave
  // anything that isn't an `issue search` alone — even an issues-shaped result.
  it("passes a result from any command other than issue search through unchanged", () => {
    const result: CliResult = { ok: true, data: { issues: [{ key: "MER-1", fields: { summary: "s" } }] } };
    for (const prefix of [["issue", "get"], ["doctor"], []]) {
      expect(extract({ binary: "jira", args: prefix, prefix }, result)).toEqual(result);
    }
  });

  it("passes a failed result through unchanged", () => {
    const result: CliResult = { ok: false, error: "jira exited with code 1: boom" };
    expect(extract(PARSED, result)).toEqual(result);
  });

  it("passes a result through unchanged when data isn't even a plain object (nothing safe to attach a note to)", () => {
    const result: CliResult = { ok: true, data: "some --help text" };
    expect(extract(PARSED, result)).toEqual(result);
  });

  // Regression: observed live — the model tried `--select formattedList`,
  // reasoning (from the system prompt alone) that formattedList must be a
  // real path in jira's own JSON. It isn't: jira evaluates --select on its
  // own raw output, before this post-processor ever runs, so that path
  // matches nothing and jira returns a bare `{}`. Previously this passed
  // through in total silence — the model got no signal at all and burned
  // two retries on the exact same broken guess before giving up.
  it("adds a formattedListNote (not silence) for a plain object with no issues array at all, e.g. --select finding nothing", () => {
    const result: CliResult = { ok: true, data: {} };
    const extracted = extract(PARSED, result);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      const data = extracted.data as { formattedListNote: string };
      expect(data.formattedListNote).toContain("--select");
      expect(data.formattedListNote.toLowerCase()).toContain("formattedlist");
      // #222: the system adds these fields, not the assistant: no name, Mercury least of all.
      expect(data.formattedListNote).toContain("added by the system to runCommand's result");
      expect(data.formattedListNote).not.toContain("Mercury");
      expect(extracted.display).toBeUndefined();
    }
  });

  it("explains in the note that formattedList/formattedListNote can never be reached via --select", () => {
    const result: CliResult = { ok: true, data: {} };
    const extracted = extract(PARSED, result);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect((extracted.data as { formattedListNote: string }).formattedListNote).toContain("--select formattedList");
    }
  });

  // Not an error — the raw data is still valid and returned untouched, just
  // with a note explaining why no list could be built, so the model can retry
  // if it turns out the user actually wanted a rendered list.
  it("adds a formattedListNote, without erroring, when issues are missing key (e.g. reshaped by --select)", () => {
    // Real shape confirmed live: `--select issues.fields.summary,issues.fields.status.name`
    // prunes "key" off each issue entirely, still under the issues[] wrapper.
    const original = { issues: [{ fields: { summary: "Ticket di test", status: { name: "Da fare" } } }] };
    const result: CliResult = { ok: true, data: original };

    const extracted = extract(PARSED, result);

    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect(extracted.data).toMatchObject(original);
      expect((extracted.data as { formattedListNote: string }).formattedListNote).toContain("--select");
      expect(extracted.display).toBeUndefined();
    }
  });

  it("adds a formattedListNote when issues array elements aren't objects at all", () => {
    const result: CliResult = { ok: true, data: { issues: ["not an issue object"] } };
    const extracted = extract(PARSED, result);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect((extracted.data as { formattedListNote: string }).formattedListNote).toBeTruthy();
      expect(extracted.display).toBeUndefined();
    }
  });

  it("emits an empty issue-list display for an empty issues array, without erroring", () => {
    const result: CliResult = { ok: true, data: { issues: [] } };
    expect(extract(PARSED, result)).toEqual({
      ok: true,
      data: { issues: [], issueCount: 0 },
      display: { type: "issue-list", items: [] },
    });
  });

  // #83: `--select` is mandatory, so a search selecting only keys (a count, an
  // existence check) is a legitimate answer. Turning it into an error threw
  // the keys away and sent the model on a retry it didn't need.
  it("returns the data untouched with a formattedListNote, not an error, when issues lack summary", () => {
    const original = { issues: [{ key: "MER-20" }, { key: "MER-21" }], nextPageToken: "abc" };
    const extracted = extract(PARSED, { ok: true, data: original });

    expect(extracted).toEqual({
      ok: true,
      data: { ...original, issueCount: 2, formattedListNote: expect.stringContaining("--select") },
    });
    expect(original).toEqual({ issues: [{ key: "MER-20" }, { key: "MER-21" }], nextPageToken: "abc" });
  });

  it("adds the note, not a list, when only some issues lack summary", () => {
    const original = { issues: [{ key: "MER-1", fields: { summary: "s" } }, { key: "MER-2" }] };
    expect(extract(PARSED, { ok: true, data: original })).toEqual({
      ok: true,
      data: { ...original, issueCount: 2, formattedListNote: expect.stringContaining("--select") },
    });
  });

  // #83: the note used to say "retry without --select" or "with --fields",
  // both of which the CLI refuses. It must name the one select that yields a list.
  it("tells the model the exact list select, never to drop --select or use --fields", () => {
    for (const data of [{}, { issues: ["not an issue"] }, { issues: [{ fields: { summary: "s" } }] }, { issues: [{ key: "MER-1" }] }]) {
      const extracted = extract(PARSED, { ok: true, data });
      expect(extracted.ok).toBe(true);
      if (extracted.ok) {
        const note = (extracted.data as { formattedListNote: string }).formattedListNote;
        expect(note).toContain(`--select ${JIRA_ISSUE_LIST_SELECT}`);
        expect(note).not.toContain("without --select");
        expect(note).not.toContain("--fields");
      }
    }
  });

  // #83: a small model asked "how many?" counted 61 keys as 63. The count
  // comes from the data, so the model reads it instead of counting.
  it("adds issueCount, the number of issues on this page, whenever the result has an issues array", () => {
    const cases: [unknown, number][] = [
      [{ issues: [] }, 0],
      [{ issues: [{ key: "MER-1" }, { key: "MER-2" }, { key: "MER-3" }], nextPageToken: "t" }, 3],
      [{ issues: [{ fields: { summary: "s" } }, { fields: { summary: "t" } }] }, 2],
      [{ issues: ["not an issue"] }, 1],
      [{ issues: [{ key: "MER-1", fields: { summary: "s" } }, { key: "MER-2", fields: { summary: "t" } }] }, 2],
    ];
    for (const [data, count] of cases) {
      const extracted = extract(PARSED, { ok: true, data });
      expect(extracted.ok).toBe(true);
      if (extracted.ok) {
        expect(extracted.data).toMatchObject(data as object);
        expect((extracted.data as { issueCount: number }).issueCount).toBe(count);
      }
    }
  });

  it("adds no issueCount when the result has no issues array", () => {
    const extracted = extract(PARSED, { ok: true, data: {} });
    expect(extracted.ok).toBe(true);
    if (extracted.ok) expect(extracted.data).not.toHaveProperty("issueCount");
  });

  it("names the select that both the CLI and the extractor accept for a list", () => {
    expect(JIRA_ISSUE_LIST_SELECT).toBe("issues.key,issues.fields.summary,issues.fields.status.name,nextPageToken");
  });

  it("emits a structured record with status and a browse link built from siteUrl + key", () => {
    const issues = [
      { key: "MER-20", fields: { summary: "Ticket di test creato da Mercury", status: { name: "Da fare" } } },
    ];
    const result: CliResult = { ok: true, data: { issues } };
    const extracted = extract(PARSED, result);
    expect(extracted).toEqual({
      ok: true,
      data: { issues, issueCount: 1 },
      display: {
        type: "issue-list",
        items: [
          {
            key: "MER-20",
            status: "Da fare",
            summary: "Ticket di test creato da Mercury",
            url: "https://example.atlassian.net/browse/MER-20",
          },
        ],
      },
    });
  });

  it("emits status: null when status wasn't requested/present", () => {
    const result: CliResult = {
      ok: true,
      data: { issues: [{ key: "MER-20", fields: { summary: "Ticket di test" } }] },
    };
    const extracted = extract(PARSED, result);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect(extracted.display).toEqual({
        type: "issue-list",
        items: [{ key: "MER-20", status: null, summary: "Ticket di test", url: "https://example.atlassian.net/browse/MER-20" }],
      });
    }
  });

  it("emits one structured record per issue", () => {
    const result: CliResult = {
      ok: true,
      data: {
        issues: [
          { key: "MER-1", fields: { summary: "First" } },
          { key: "MER-2", fields: { summary: "Second" } },
        ],
      },
    };
    const extracted = extract(PARSED, result);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect(extracted.display).toEqual({
        type: "issue-list",
        items: [
          { key: "MER-1", status: null, summary: "First", url: "https://example.atlassian.net/browse/MER-1" },
          { key: "MER-2", status: null, summary: "Second", url: "https://example.atlassian.net/browse/MER-2" },
        ],
      });
    }
  });

  it("strips a trailing slash on siteUrl before building the link", () => {
    const withTrailingSlash = createJiraIssueListExtractor({ siteUrl: "https://example.atlassian.net/" });
    const result: CliResult = { ok: true, data: { issues: [{ key: "MER-1", fields: { summary: "x" } }] } };
    const extracted = withTrailingSlash(PARSED, result);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect(extracted.display).toEqual({
        type: "issue-list",
        items: [{ key: "MER-1", status: null, summary: "x", url: "https://example.atlassian.net/browse/MER-1" }],
      });
    }
  });

  it("preserves every original field on each issue in data — augments, never replaces", () => {
    const result: CliResult = {
      ok: true,
      data: { issues: [{ key: "MER-1", fields: { summary: "x" }, self: "https://api.atlassian.com/..." }] },
    };
    const extracted = extract(PARSED, result);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      const data = extracted.data as { issues: Array<{ self: string }> };
      expect(data.issues[0]?.self).toBe("https://api.atlassian.com/...");
    }
  });
});
