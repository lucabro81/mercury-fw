import { describe, expect, test } from "bun:test";
import { filterJql, type JqlIssue } from "./jql.ts";

const NOW = new Date("2026-10-20T10:00:00Z");
const ME = "acc-me";

const issue = (over: Partial<JqlIssue> & { key: string }): JqlIssue => ({
  project: "KAN",
  summary: "something",
  status: "To Do",
  statusCategory: "To Do",
  assignee: null,
  duedate: null,
  created: "2026-10-01T09:00:00Z",
  ...over,
});

const issues: JqlIssue[] = [
  issue({ key: "KAN-1", summary: "Login page broken", assignee: { accountId: ME, displayName: "Sam Rivera" }, duedate: "2026-10-18" }),
  issue({ key: "KAN-2", status: "In Progress", statusCategory: "In Progress", assignee: { accountId: "acc-ada", displayName: "Ada Moretti" }, duedate: "2026-10-25" }),
  issue({ key: "KAN-3", status: "Done", statusCategory: "Done", created: "2026-10-17T09:00:00Z" }),
  issue({ key: "OPS-1", project: "OPS", summary: "Rotate the login certificates" }),
];

const keys = (jql: string) => {
  const result = filterJql(jql, issues, { now: NOW, currentUser: ME });
  return result.ok ? result.issues.map((i) => i.key) : result;
};

describe("filterJql", () => {
  test("a project, in the order Jira returns them (newest key first)", () => {
    expect(keys("project = KAN")).toEqual(["KAN-3", "KAN-2", "KAN-1"]);
  });

  test("open issues: statusCategory != Done", () => {
    expect(keys("project = KAN AND statusCategory != Done")).toEqual(["KAN-2", "KAN-1"]);
  });

  test("a status by its name, quoted or not, any case of the keyword", () => {
    expect(keys('project = KAN and status = "In Progress"')).toEqual(["KAN-2"]);
    expect(keys("project = KAN AND status = Done")).toEqual(["KAN-3"]);
    expect(keys("project = KAN AND status != Done")).toEqual(["KAN-2", "KAN-1"]);
  });

  test("a status wording that isn't Jira's matches nothing, as in Jira", () => {
    expect(keys('project = KAN AND status = "todo"')).toEqual([]);
  });

  test("the assignee: currentUser(), a display name, or EMPTY", () => {
    expect(keys("assignee = currentUser()")).toEqual(["KAN-1"]);
    expect(keys("assignee = 'Ada Moretti'")).toEqual(["KAN-2"]);
    expect(keys("project = KAN AND assignee is EMPTY")).toEqual(["KAN-3"]);
  });

  test("summary ~ is a case-insensitive word match", () => {
    expect(keys('summary ~ "login"')).toEqual(["OPS-1", "KAN-1"]);
  });

  test("dates against now(), and relative offsets", () => {
    expect(keys("duedate < now()")).toEqual(["KAN-1"]);
    expect(keys("project = KAN AND created >= -7d")).toEqual(["KAN-3"]);
    expect(keys('duedate <= "2026-10-25"')).toEqual(["KAN-2", "KAN-1"]);
  });

  test("ORDER BY is accepted and ignored", () => {
    expect(keys("project = KAN AND statusCategory != Done ORDER BY updated DESC")).toEqual(["KAN-2", "KAN-1"]);
  });

  test("a project key that doesn't exist matches nothing", () => {
    expect(keys("project = NOPE")).toEqual([]);
  });

  test("a clause it doesn't know is reported, never guessed", () => {
    expect(keys("project = KAN AND sprint in openSprints()")).toEqual({ ok: false, unsupported: "sprint in openSprints()" });
    expect(keys("project = KAN OR project = OPS")).toEqual({ ok: false, unsupported: "project = KAN OR project = OPS" });
  });
});
