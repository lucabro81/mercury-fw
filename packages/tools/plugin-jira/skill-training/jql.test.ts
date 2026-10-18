import { describe, expect, test } from "bun:test";
import { filterJql, type JqlContext, type JqlIssue } from "./jql.ts";

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
  issue({ key: "KAN-1", summary: "Login page broken", assignee: { accountId: ME, displayName: "Sam Rivera" }, duedate: "2026-10-18", issuetype: "Bug", priority: "High" }),
  issue({ key: "KAN-2", status: "In Progress", statusCategory: "In Progress", assignee: { accountId: "acc-ada", displayName: "Ada Moretti" }, duedate: "2026-10-25", issuetype: "Task", priority: "Low" }),
  issue({ key: "KAN-3", status: "Done", statusCategory: "Done", created: "2026-10-17T09:00:00Z" }),
  issue({ key: "OPS-1", project: "OPS", summary: "Rotate the login certificates" }),
];

const ctx: JqlContext = {
  now: NOW,
  currentUser: ME,
  projects: ["KAN", "OPS"],
  statuses: ["To Do", "In Progress", "Done"],
  users: [
    { accountId: ME, displayName: "Sam Rivera" },
    { accountId: "acc-ada", displayName: "Ada Moretti" },
  ],
  issuetypes: ["Bug", "Task"],
  priorities: ["High", "Low"],
};

const keys = (jql: string) => {
  const result = filterJql(jql, issues, ctx);
  return result.ok ? result.issues.map((i) => i.key) : result;
};

describe("filterJql", () => {
  test("a project, in the order Jira returns them (newest key first)", () => {
    expect(keys("project = KAN")).toEqual(["KAN-3", "KAN-2", "KAN-1"]);
  });

  test("open issues: statusCategory != Done", () => {
    expect(keys("project = KAN AND statusCategory != Done")).toEqual(["KAN-2", "KAN-1"]);
  });

  test("a status by its name, quoted or a single word unquoted, any case", () => {
    expect(keys('project = KAN and status = "In Progress"')).toEqual(["KAN-2"]);
    expect(keys("project = KAN AND status = done")).toEqual(["KAN-3"]);
    expect(keys("project = KAN AND status != Done")).toEqual(["KAN-2", "KAN-1"]);
  });

  test("the assignee: currentUser(), a display name, EMPTY", () => {
    expect(keys("assignee = currentUser()")).toEqual(["KAN-1"]);
    expect(keys("assignee = 'Ada Moretti'")).toEqual(["KAN-2"]);
    expect(keys("project = KAN AND assignee is EMPTY")).toEqual(["KAN-3"]);
  });

  test("summary ~ is a case-insensitive word match", () => {
    expect(keys('summary ~ "login"')).toEqual(["OPS-1", "KAN-1"]);
  });

  test("dates against now(), relative offsets, and EMPTY or null", () => {
    expect(keys("duedate < now()")).toEqual(["KAN-1"]);
    expect(keys("project = KAN AND created >= -7d")).toEqual(["KAN-3"]);
    expect(keys('duedate <= "2026-10-25"')).toEqual(["KAN-2", "KAN-1"]);
    expect(keys("project = KAN AND duedate is not null")).toEqual(["KAN-2", "KAN-1"]);
    expect(keys("project = KAN AND duedate is EMPTY")).toEqual(["KAN-3"]);
  });

  test("the issue type and the priority, by name", () => {
    expect(keys("issuetype = Bug")).toEqual(["KAN-1"]);
    expect(keys('type = "task"')).toEqual(["KAN-2"]);
    expect(keys("priority = High")).toEqual(["KAN-1"]);
  });

  test("ORDER BY is accepted and ignored", () => {
    expect(keys("project = KAN AND statusCategory != Done ORDER BY updated DESC")).toEqual(["KAN-2", "KAN-1"]);
  });

  // Jira refuses a value its field doesn't have, it doesn't answer an empty
  // list: an empty result here taught the model "nobody" for `assignee = "Marco"`.
  test("a value the field doesn't have is Jira's error, not an empty result", () => {
    expect(keys('project = KAN AND status = "todo"')).toEqual({ ok: false, error: "The value 'todo' does not exist for the field 'status'." });
    expect(keys("project = NOPE")).toEqual({ ok: false, error: "The value 'NOPE' does not exist for the field 'project'." });
    expect(keys('assignee = "Marco"')).toEqual({ ok: false, error: "The value 'Marco' does not exist for the field 'assignee'." });
    expect(keys("statusCategory = Waiting")).toEqual({ ok: false, error: "The value 'Waiting' does not exist for the field 'statusCategory'." });
  });

  test("an issue by its key, and Jira's error for a key that doesn't exist", () => {
    expect(keys("key = KAN-2")).toEqual(["KAN-2"]);
    expect(keys("project = KAN AND key != KAN-2")).toEqual(["KAN-3", "KAN-1"]);
    expect(keys("key = KAN-404")).toEqual({ ok: false, error: "An issue with key 'KAN-404' does not exist for field 'key'." });
  });

  test("a value of several words without quotes is a syntax error", () => {
    expect(keys("project = KAN AND status = In Progress")).toEqual({
      ok: false,
      error: "Error in the JQL Query: Expecting either 'OR' or 'AND' but got 'Progress'. (line 1, character 31)",
    });
  });

  test("a reserved character outside quotes is a syntax error", () => {
    expect(keys("project = KAN AND duedate <= now()+5d")).toEqual({
      ok: false,
      error: "Error in the JQL Query: The character '+' is a reserved JQL character. You must enclose it in a string or use the escape '\\u002b' instead. (line 1, character 35)",
    });
  });

  test("a clause it doesn't know is reported, never guessed", () => {
    expect(keys("project = KAN AND sprint in openSprints()")).toEqual({ ok: false, unsupported: "sprint in openSprints()" });
    expect(keys("project = KAN OR project = OPS")).toEqual({ ok: false, unsupported: "project = KAN OR project = OPS" });
  });
});
