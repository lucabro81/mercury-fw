/**
 * The fake jira CLI's printing, checked against what the real one (2.3.2)
 * printed for the same shapes: each expectation here is one observed answer,
 * with the values made up.
 */
import { describe, expect, test } from "bun:test";
import { page, printed, select } from "./jira-cli.ts";

const call = (flags: Record<string, string | true>) => ({ args: [], positionals: [], flags });

const search = {
  isLast: false,
  issues: [
    { key: "KAN-3", fields: { summary: "Login page broken", status: { name: "To Do" }, duedate: null, assignee: null } },
    { key: "KAN-2", fields: { summary: "Export to CSV", status: { name: "In Progress" }, duedate: "2026-11-02", assignee: { displayName: "Ada Moretti" } } },
  ],
  nextPageToken: "TOKEN",
};

describe("select", () => {
  test("projects every element of an array", () => {
    expect(select(search, ["issues.key"])).toEqual({ issues: [{ key: "KAN-3" }, { key: "KAN-2" }] });
  });

  test("merges several paths into one shape", () => {
    expect(select(search, ["issues.key", "issues.fields.summary", "issues.fields.status.name", "nextPageToken"])).toEqual({
      issues: [
        { key: "KAN-3", fields: { summary: "Login page broken", status: { name: "To Do" } } },
        { key: "KAN-2", fields: { summary: "Export to CSV", status: { name: "In Progress" } } },
      ],
      nextPageToken: "TOKEN",
    });
  });

  test("drops a path whose first part isn't there and keeps the rest", () => {
    expect(select(search, ["issues.key", "formattedList"])).toEqual({ issues: [{ key: "KAN-3" }, { key: "KAN-2" }] });
  });

  test("keeps the part of a path that exists: a missing leaf leaves its parent empty", () => {
    expect(select(search, ["formattedList", "issues.fields.nope"])).toEqual({ issues: [{ fields: {} }, { fields: {} }] });
  });

  test("nothing matching at all is {}", () => {
    expect(select(search, ["formattedList"])).toEqual({});
  });

  test("a null stays null, also when the path goes past it", () => {
    expect(select(search, ["issues.fields.duedate", "issues.fields.assignee.displayName"])).toEqual({
      issues: [{ fields: { duedate: null, assignee: null } }, { fields: { duedate: "2026-11-02", assignee: { displayName: "Ada Moretti" } } }],
    });
  });

  test("a top-level array is projected element by element; a wrong path gives an empty object for each", () => {
    const users = [{ accountId: "acc-1", displayName: "Ada Moretti", active: true, emailAddress: "x" }];
    expect(select(users, ["accountId", "displayName"])).toEqual([{ accountId: "acc-1", displayName: "Ada Moretti" }]);
    expect(select(users, ["displayname"])).toEqual([{}]);
    expect(select([], ["accountId"])).toEqual([]);
  });

  test("an absent field isn't added", () => {
    const last = { isLast: true, issues: [] };
    expect(select(last, ["issues.key", "nextPageToken", "isLast"])).toEqual({ isLast: true, issues: [] });
  });
});

describe("printed", () => {
  test("with --select, the projection", () => {
    expect(printed(search, call({ "--select": "issues.key,nextPageToken" }))).toEqual({ ok: true, data: { issues: [{ key: "KAN-3" }, { key: "KAN-2" }], nextPageToken: "TOKEN" } });
  });

  test("without --select, refused on stderr with exit 1, saying the size and the top-level fields", () => {
    const bytes = Buffer.byteLength(JSON.stringify(search, null, 2));
    expect(printed(search, call({}))).toEqual({
      ok: false,
      exitCode: 1,
      error:
        `jira exited with code 1: refusing to print the full ${bytes}-byte JSON response without --select — an omitted --select would likely flood the caller's context window. ` +
        "top-level fields: isLast, issues, nextPageToken. Retry with --select and one or more dot-notation paths built from the fields above " +
        "(e.g. --select fieldName or --select fieldName.nestedField), or pass --select-all to explicitly confirm printing the unfiltered response.",
    });
  });

  test("--select-all prints everything when small", () => {
    expect(printed(search, call({ "--select-all": true }))).toEqual({ ok: true, data: search });
  });

  test("--select-all is refused above 30000 bytes", () => {
    const big = { isLast: true, issues: Array.from({ length: 400 }, (_, i) => ({ key: `KAN-${i}`, fields: { summary: "x".repeat(60) } })) };
    const bytes = Buffer.byteLength(JSON.stringify(big, null, 2));
    expect(printed(big, call({ "--select-all": true }))).toEqual({
      ok: false,
      exitCode: 1,
      error:
        `jira exited with code 1: refusing to print the full ${bytes}-byte JSON response even with --select-all — it exceeds the 30000-byte cap and would likely flood the caller's context window. ` +
        "top-level fields: isLast, issues. Retry with --select and one or more dot-notation paths built from the fields above " +
        "(e.g. --select fieldName or --select fieldName.nestedField) to narrow the response instead.",
    });
  });

  test("a command exempt from --select prints in full without it", () => {
    const created = { browse_url: "https://example.atlassian.net/browse/KAN-9", id: "10009", key: "KAN-9", self: "https://api/issue/10009" };
    expect(printed(created, call({}), { exempt: true })).toEqual({ ok: true, data: created });
  });
});

describe("page", () => {
  const issues = Array.from({ length: 5 }, (_, i) => ({ key: `KAN-${5 - i}` }));

  test("a first page with more after it carries a token and isLast false", () => {
    const first = page(issues, call({ "--max-results": "2" }));
    expect(first.issues).toEqual([{ key: "KAN-5" }, { key: "KAN-4" }]);
    expect(first.isLast).toBe(false);
    expect(typeof first.nextPageToken).toBe("string");
  });

  test("the token gets the next page, and the last page has no token and isLast true", () => {
    const first = page(issues, call({ "--max-results": "2" }));
    const second = page(issues, call({ "--max-results": "2", "--page-token": first.nextPageToken as string }));
    expect(second.issues).toEqual([{ key: "KAN-3" }, { key: "KAN-2" }]);
    const third = page(issues, call({ "--max-results": "2", "--page-token": second.nextPageToken as string }));
    expect(third).toEqual({ isLast: true, issues: [{ key: "KAN-1" }] });
  });

  test("no matches is an empty last page", () => {
    expect(page([], call({}))).toEqual({ isLast: true, issues: [] });
  });

  test("without --max-results, 50 a page", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `KAN-${i}` }));
    expect(page(many, call({})).issues).toHaveLength(50);
  });
});
