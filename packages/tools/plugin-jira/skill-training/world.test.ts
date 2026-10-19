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

  test("a value Jira doesn't have is its 400, as the CLI prints it", async () => {
    const { run } = jira();
    expect(await run("issue", "search", "--jql", 'project = WEB AND status = "todo"', "--select", "issues.key")).toEqual({
      ok: false,
      exitCode: 1,
      error: `jira exited with code 1: Jira API returned status 400: {"errorMessages":["The value 'todo' does not exist for the field 'status'."],"errors":{}}`,
    });
    expect((await run("issue", "search", "--jql", 'assignee = "Marco"', "--select", "issues.key")).ok).toBe(false);
  });

  test("nothing matching is an empty last page", async () => {
    const { run } = jira();
    expect(await run("issue", "search", "--jql", 'project = WEB AND summary ~ "zzzqqq"', "--select", "issues.key,nextPageToken,isLast")).toEqual({
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
    expect(second.data.issues).toHaveLength(20);
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

// From the fifth cold review: inventions the fixtures accepted.
describe("what Jira and the CLI refuse", () => {
  test("create refuses a type, a priority or an assignee that doesn't exist", async () => {
    const { run } = jira();
    for (const extra of [["--type", "Banana"], ["--priority", "Urgentissima"], ["--assignee", "nobody-123"]]) {
      const args = ["issue", "create", "--project", "WEB", "--type", "Task", "--summary", "x"];
      const at = args.indexOf(extra[0]!);
      if (at === -1) args.push(...extra);
      else args[at + 1] = extra[1]!;
      expect((await run(...args)).ok).toBe(false);
    }
  });

  test("a command needing an issue key without one is clap's missing argument", async () => {
    const { run } = jira();
    for (const args of [["issue", "get", "--select", "key"], ["issue", "transition", "--to", "Done"], ["issue", "transitions"], ["issue", "assign", "--unassign"], ["issue", "comment", "add", "--body", "x"]]) {
      expect(await run(...args)).toMatchObject({ ok: false, exitCode: 2, error: expect.stringContaining("<KEY>") });
    }
  });

  test("a --max-results that isn't a whole number is clap's invalid value, and above 100 gets 100", async () => {
    const { run } = jira();
    expect(await run("issue", "search", "--jql", "project = LOG", "--max-results", "abc", "--select", "issues.key")).toMatchObject({ ok: false, exitCode: 2 });
    expect(await run("issue", "search", "--jql", "project = LOG", "--max-results", "-5", "--select", "issues.key")).toMatchObject({ ok: false, exitCode: 2 });
    const capped = (await run("issue", "search", "--jql", "project = LOG", "--max-results", "150", "--select", "issues.key")) as { data: { issues: unknown[] } };
    expect(capped.data.issues).toHaveLength(100);
  });

  test("an inline {{mention:ID}} comes back as a mention node where it was written", async () => {
    const { run } = jira();
    const result = (await run("issue", "comment", "add", "WEB-3", "--body", `Thanks {{mention:${ACCOUNTS.giulia}}} for the fix`)) as {
      data: { body: { content: Array<{ content: Array<{ type: string; text?: string; attrs?: { id: string; text: string; accessLevel: string } }> }> } };
    };
    expect(result.data.body.content[0]!.content).toEqual([
      { type: "text", text: "Thanks " },
      { type: "mention", attrs: { id: ACCOUNTS.giulia, text: "@Giulia Ferri", accessLevel: "" } },
      { type: "text", text: " for the fix" },
    ]);
  });
});

describe("inactive people and the user search", () => {
  // Jira doesn't let an issue go to someone whose account is deactivated.
  test("assigning to an inactive person is Jira's refusal", async () => {
    const { run } = jira();
    expect(await run("issue", "assign", "MRT-4", "--assignee", ACCOUNTS.lena)).toEqual({
      ok: false,
      exitCode: 1,
      error: `jira exited with code 1: Jira API returned status 400: {"errorMessages":[],"errors":{"assignee":"User 'Lena Hoffmann' cannot be assigned issues."}}`,
    });
  });

  test("an issue's assignee says whether they're active", async () => {
    const { run } = jira();
    expect(await run("issue", "get", "OPS-1", "--select", "fields.assignee.active")).toEqual({ ok: true, data: { fields: { assignee: { active: false } } } });
  });

  test("the user search matches the start of a name's words or of the email, not the middle", async () => {
    const { run } = jira();
    const names = async (query: string) =>
      ((await run("user", "search", "--query", query, "--select", "displayName")) as { data: Array<{ displayName: string }> }).data.map((u) => u.displayName);
    expect(await names("hoff")).toEqual(["Lena Hoffmann"]);
    expect(await names("ffmann")).toEqual([]);
    expect(await names("giulia.f")).toEqual(["Giulia Ferri"]);
  });

  // A full name is how the skill teaches the user search (`--query "Jane Doe"`):
  // the word-start matching made every such query come back empty.
  test("a query of several words finds who has every word at the start of one of theirs", async () => {
    const { run } = jira();
    const names = async (query: string) =>
      ((await run("user", "search", "--query", query, "--select", "displayName")) as { data: Array<{ displayName: string }> }).data.map((u) => u.displayName);
    expect(await names("Marco Bianchi")).toEqual(["Marco Bianchi"]);
    expect(await names("ada c")).toEqual(["Ada Conti"]);
    expect(await names("Paolo Verdi")).toEqual([]);
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

describe("usage errors", () => {
  // The model wrote `issue transition OPS-4 --transition 41` in a live run: the
  // real CLI rejects it as clap does (exit 2), it's the model's mistake to
  // learn from, not a hole in the fixtures.
  test("a flag the command doesn't have is clap's unexpected argument, exit 2", async () => {
    const { run, cli } = jira();
    expect(await run("issue", "transition", "OPS-4", "--transition", "41")).toEqual({
      ok: false,
      exitCode: 2,
      error:
        "jira exited with code 2: error: unexpected argument '--transition' found\n\nUsage: jira issue transition [OPTIONS] --to <TO> <KEY>\n\nFor more information, try '--help'.",
    });
    expect(cli.unmatched()).toEqual([]);
  });

  test("a required flag left out is clap's missing argument, exit 2", async () => {
    const { run } = jira();
    expect(await run("issue", "create", "--project", "WEB", "--summary", "x")).toEqual({
      ok: false,
      exitCode: 2,
      error:
        "jira exited with code 2: error: the following required arguments were not provided:\n  --type <ISSUE_TYPE>\n\nUsage: jira issue create [OPTIONS] --project <PROJECT> --type <ISSUE_TYPE> --summary <SUMMARY>\n\nFor more information, try '--help'.",
    });
  });

  test("the flags every command takes are no usage error", async () => {
    const { run } = jira();
    expect((await run("issue", "transition", "WEB-3", "--to", "Done", "--select", "key")).ok).toBe(true);
  });

  test("a search without --jql, or with a flag it doesn't have, is clap's refusal", async () => {
    const { run } = jira();
    expect(await run("issue", "search", "--select", "issues.key")).toMatchObject({
      ok: false,
      exitCode: 2,
      error: expect.stringContaining("the following required arguments were not provided:\n  --jql <JQL>"),
    });
    expect(await run("issue", "search", "--jql", "project = WEB", "--limit", "5", "--select", "issues.key")).toMatchObject({
      ok: false,
      exitCode: 2,
      error: expect.stringContaining("unexpected argument '--limit' found"),
    });
  });

  test("a search takes --fields, and --max-results above 100 gets 100", async () => {
    const { run } = jira();
    const result = (await run("issue", "search", "--jql", "project = LOG", "--max-results", "500", "--fields", "summary,status", "--select", "issues.key")) as {
      ok: true;
      data: { issues: unknown[] };
    };
    expect(result.data.issues).toHaveLength(100);
  });

  test("issue get takes no flags of its own", async () => {
    const { run } = jira();
    expect(await run("issue", "get", "WEB-3", "--fields", "summary", "--select", "key")).toMatchObject({ ok: false, exitCode: 2 });
  });

  test("assign with neither --assignee nor --unassign is the CLI's own refusal", async () => {
    const { run } = jira();
    expect(await run("issue", "assign", "WEB-3")).toMatchObject({ ok: false, exitCode: 2 });
  });
});

describe("--help", () => {
  test("a command's help as text", async () => {
    const { run } = jira();
    const result = (await run("issue", "transition", "--help")) as { ok: true; data: string };
    expect(result.data).toContain("--to <TO>");
  });

  test("search and get have their help too", async () => {
    const { run } = jira();
    expect(((await run("issue", "search", "--help")) as { data: string }).data).toContain("--page-token <PAGE_TOKEN>");
    expect(((await run("issue", "get", "-h")) as { data: string }).data).toContain("Usage: jira issue get [OPTIONS] <KEY>");
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
