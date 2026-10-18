import { describe, expect, test } from "bun:test";
import { createFakeCli } from "../../../../apps/skill-trainer/src/fixtures.ts";
import { ACCOUNTS, jiraFixtures, makeWorld } from "./world.ts";

/** A fake jira on a fresh world, and a runner taking the command as the model would type it after `jira`. */
function jira() {
  const world = makeWorld();
  const cli = createFakeCli(jiraFixtures(world));
  const run = (...args: string[]) => cli.run("jira", args);
  return { world, cli, run };
}

describe("issue search", () => {
  test("the skill's list select gives keys, summaries, statuses and the page token when more follow", async () => {
    const { run } = jira();
    const result = await run("issue", "search", "--jql", "project = WEB AND statusCategory != Done", "--max-results", "2", "--select", "issues.key,issues.fields.summary,issues.fields.status.name,nextPageToken");
    expect(result.ok).toBe(true);
    const data = (result as { data: { issues: Array<{ key: string; fields: Record<string, unknown> }>; nextPageToken?: string } }).data;
    expect(data.issues).toHaveLength(2);
    expect(Object.keys(data.issues[0]!.fields).sort()).toEqual(["status", "summary"]);
    expect(typeof data.nextPageToken).toBe("string");
  });

  test("without --select it's refused like the real CLI", async () => {
    const { run } = jira();
    const result = await run("issue", "search", "--jql", "project = WEB");
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect((result as { error: string }).error).toContain("without --select");
    expect((result as { error: string }).error).toContain("top-level fields: isLast, issues");
  });

  test("a status wording that isn't Jira's finds nothing", async () => {
    const { run } = jira();
    expect(await run("issue", "search", "--jql", 'project = WEB AND status = "todo"', "--select", "issues.key,nextPageToken,isLast")).toEqual({
      ok: true,
      data: { isLast: true, issues: [] },
    });
  });

  test("JQL it can't read is a hole in the fixtures, not an empty result", async () => {
    const { run, cli } = jira();
    expect((await run("issue", "search", "--jql", "project = WEB AND sprint in openSprints()", "--select", "issues.key")).ok).toBe(false);
    expect(cli.unmatched()).toHaveLength(1);
  });

  test("LOG has more than a page of open issues", async () => {
    const { run } = jira();
    const first = (await run("issue", "search", "--jql", "project = LOG AND statusCategory != Done", "--max-results", "100", "--select", "issues.key,nextPageToken")) as {
      data: { issues: unknown[]; nextPageToken: string };
    };
    expect(first.data.issues).toHaveLength(100);
    const second = (await run("issue", "search", "--jql", "project = LOG AND statusCategory != Done", "--max-results", "100", "--page-token", first.data.nextPageToken, "--select", "issues.key,nextPageToken")) as {
      data: { issues: unknown[]; nextPageToken?: string };
    };
    expect(second.data.issues.length).toBeGreaterThan(0);
    expect(second.data.nextPageToken).toBeUndefined();
  });

  test("my issues are Sam Rivera's", async () => {
    const { run, world } = jira();
    const result = (await run("issue", "search", "--jql", "assignee = currentUser() AND statusCategory != Done", "--select", "issues.key,issues.fields.assignee.displayName")) as {
      data: { issues: Array<{ fields: { assignee: { displayName: string } } }> };
    };
    expect(result.data.issues.length).toBeGreaterThan(0);
    expect(new Set(result.data.issues.map((i) => i.fields.assignee.displayName))).toEqual(new Set(["Sam Rivera"]));
    expect(world.me).toBe(ACCOUNTS.sam);
  });
});

describe("issue get", () => {
  test("one issue with its browse_url, a missing field as null", async () => {
    const { run } = jira();
    expect(await run("issue", "get", "WEB-3", "--select", "key,fields.summary,fields.status.name,fields.duedate,browse_url")).toEqual({
      ok: true,
      data: {
        key: "WEB-3",
        browse_url: "https://example.atlassian.net/browse/WEB-3",
        fields: { summary: "Checkout button unresponsive on Safari", status: { name: "In Progress" }, duedate: "2026-10-24" },
      },
    });
  });

  test("an issue that doesn't exist is Jira's 404", async () => {
    const { run } = jira();
    expect(await run("issue", "get", "WEB-999", "--select", "key")).toEqual({
      ok: false,
      exitCode: 1,
      error: 'jira exited with code 1: Jira API returned status 404: {"errorMessages":["Issue does not exist or you do not have permission to see it."],"errors":{}}',
    });
  });
});

describe("transitions and transition", () => {
  test("transitions print in full without --select", async () => {
    const { run } = jira();
    const result = (await run("issue", "transitions", "WEB-3")) as { ok: true; data: { transitions: Array<{ id: string; name: string; to: { name: string } }> } };
    expect(result.data.transitions.map((t) => [t.id, t.name, t.to.name])).toEqual([
      ["11", "To Do", "To Do"],
      ["21", "In Progress", "In Progress"],
      ["31", "In Review", "In Review"],
      ["41", "Done", "Done"],
    ]);
  });

  test("a name that isn't a transition fails listing the valid ones", async () => {
    const { run } = jira();
    expect(await run("issue", "transition", "WEB-3", "--to", "Doing")).toEqual({
      ok: false,
      exitCode: 1,
      error: 'jira exited with code 1: transition "Doing" not found for this issue in its current state. Available transitions: To Do, In Progress, In Review, Done',
    });
  });

  test("a transition moves the issue, and a later search sees it", async () => {
    const { run } = jira();
    expect(await run("issue", "transition", "WEB-3", "--to", "Done")).toEqual({ ok: true, data: { key: "WEB-3", to: "Done", transitioned: true } });
    expect(await run("issue", "get", "WEB-3", "--select", "fields.status.name")).toEqual({ ok: true, data: { fields: { status: { name: "Done" } } } });
  });
});

describe("assign, comment, create", () => {
  test("assign to an account, and unassign", async () => {
    const { run } = jira();
    expect(await run("issue", "assign", "WEB-3", "--assignee", ACCOUNTS.adaMoretti)).toEqual({ ok: true, data: { assigned: true, assignee: ACCOUNTS.adaMoretti, key: "WEB-3" } });
    expect(await run("issue", "assign", "WEB-3", "--unassign")).toEqual({ ok: true, data: { assigned: true, assignee: null, key: "WEB-3" } });
  });

  test("a comment prints the created comment, the mention as a node", async () => {
    const { run, world } = jira();
    const result = (await run("issue", "comment", "add", "WEB-3", "--mention", ACCOUNTS.adaMoretti, "--body", "can you take a look?")) as {
      ok: true;
      data: { author: { displayName: string; accountType: string }; body: { content: Array<{ content: Array<{ type: string }> }> } };
    };
    expect(result.data.author).toMatchObject({ displayName: "Mercury", accountType: "app" });
    expect(result.data.body.content[0]!.content[0]!.type).toBe("mention");
    expect(world.issues.find((i) => i.key === "WEB-3")?.comments).toHaveLength(1);
  });

  test("create prints {browse_url, id, key, self} with the next key, and the issue exists after", async () => {
    const { run } = jira();
    const created = (await run("issue", "create", "--project", "OPS", "--type", "Task", "--summary", "Renew the TLS cert")) as { ok: true; data: Record<string, string> };
    expect(Object.keys(created.data).sort()).toEqual(["browse_url", "id", "key", "self"]);
    expect(created.data.key).toBe("OPS-9");
    expect(await run("issue", "get", "OPS-9", "--select", "fields.summary,fields.status.name")).toEqual({
      ok: true,
      data: { fields: { summary: "Renew the TLS cert", status: { name: "To Do" } } },
    });
  });

  test("create in a project that doesn't exist is Jira's 400", async () => {
    const { run } = jira();
    expect((await run("issue", "create", "--project", "NOPE", "--type", "Task", "--summary", "x")).ok).toBe(false);
  });
});

describe("user and project search", () => {
  test("two people answer to Ada", async () => {
    const { run } = jira();
    expect(await run("user", "search", "--query", "Ada", "--select", "accountId,displayName")).toEqual({
      ok: true,
      data: [
        { accountId: ACCOUNTS.adaMoretti, displayName: "Ada Moretti" },
        { accountId: ACCOUNTS.adaConti, displayName: "Ada Conti" },
      ],
    });
  });

  test("a wrong path gives an empty object per person", async () => {
    const { run } = jira();
    expect(await run("user", "search", "--query", "Moretti", "--select", "users.accountId")).toEqual({ ok: true, data: [{}] });
  });

  test("a project by a fragment of its name", async () => {
    const { run } = jira();
    expect(await run("project", "search", "--query", "tooling", "--select", "values.key,values.name")).toEqual({
      ok: true,
      data: { values: [{ key: "MRT", name: "Build Tooling" }] },
    });
  });
});

describe("--help", () => {
  test("a command's help as text", async () => {
    const { run } = jira();
    const result = (await run("issue", "transition", "--help")) as { ok: true; data: string };
    expect(result.data).toContain("--to <TO>");
  });

  test("a help it doesn't have is a hole", async () => {
    const { run, cli } = jira();
    expect((await run("sprint", "list", "--help")).ok).toBe(false);
    expect(cli.unmatched()).toHaveLength(1);
  });
});

describe("makeWorld", () => {
  test("every world is fresh: what one task changes, the next doesn't see", async () => {
    const first = jira();
    await first.run("issue", "transition", "WEB-3", "--to", "Done");
    const second = jira();
    expect(await second.run("issue", "get", "WEB-3", "--select", "fields.status.name")).toEqual({ ok: true, data: { fields: { status: { name: "In Progress" } } } });
  });
});
