import { describe, expect, test } from "bun:test";
import type { Fixture } from "./contract.ts";
import { createFakeCli } from "./fixtures.ts";

const ok = (data: unknown) => ({ ok: true as const, data });

const search: Fixture = {
  command: ["issue", "search"],
  flags: { "--jql": /project = KAN/, "--select": /issues\.key/ },
  result: ok({ issues: [{ key: "KAN-1" }] }),
};

describe("createFakeCli", () => {
  test("answers a command matching a fixture with its result", async () => {
    const cli = createFakeCli([search]);
    const result = await cli.run("jira", ["issue", "search", "--jql", "project = KAN", "--select", "issues.key"]);
    expect(result).toEqual({ ok: true, data: { issues: [{ key: "KAN-1" }] } });
    expect(cli.unmatched()).toEqual([]);
  });

  test("ignores the order of the flags", async () => {
    const cli = createFakeCli([search]);
    const result = await cli.run("jira", ["issue", "search", "--select", "issues.key,nextPageToken", "--jql", "project = KAN AND status = Done"]);
    expect(result.ok).toBe(true);
  });

  test("reads a flag's value given as --flag=value", async () => {
    const cli = createFakeCli([search]);
    const result = await cli.run("jira", ["issue", "search", "--jql=project = KAN", "--select=issues.key"]);
    expect(result.ok).toBe(true);
  });

  test("matches the command on whole leading tokens only", async () => {
    const cli = createFakeCli([{ command: ["issue", "search"], result: ok("hit") }]);
    expect((await cli.run("jira", ["issue", "searches"])).ok).toBe(false);
    expect((await cli.run("jira", ["user", "search"])).ok).toBe(false);
    expect((await cli.run("jira", ["issue"])).ok).toBe(false);
    expect((await cli.run("jira", ["issue", "search", "--jql", "x"])).ok).toBe(true);
  });

  test("the first fixture that matches wins", async () => {
    const cli = createFakeCli([
      { command: ["issue", "search"], flags: { "--select": false }, result: ok("refused: no --select") },
      { command: ["issue", "search"], result: ok("generic") },
    ]);
    expect(await cli.run("jira", ["issue", "search", "--jql", "x"])).toEqual(ok("refused: no --select"));
    expect(await cli.run("jira", ["issue", "search", "--jql", "x", "--select", "issues.key"])).toEqual(ok("generic"));
  });

  test("a flag condition: true needs the flag, false needs it absent", async () => {
    const cli = createFakeCli([{ command: ["issue", "assign"], flags: { "--unassign": true }, result: ok("unassigned") }]);
    expect((await cli.run("jira", ["issue", "assign", "KAN-4", "--unassign"])).ok).toBe(true);
    expect((await cli.run("jira", ["issue", "assign", "KAN-4", "--assignee", "abc"])).ok).toBe(false);
  });

  test("a string condition needs the exact value, not a part of it", async () => {
    const cli = createFakeCli([{ command: ["issue", "assign"], flags: { "--assignee": "acc-1" }, result: ok("assigned") }]);
    expect((await cli.run("jira", ["issue", "assign", "KAN-4", "--assignee", "acc-1"])).ok).toBe(true);
    expect((await cli.run("jira", ["issue", "assign", "KAN-4", "--assignee", "acc-12"])).ok).toBe(false);
  });

  test("a valueless flag followed by another flag doesn't take that flag as its value", async () => {
    const cli = createFakeCli([
      { command: ["issue", "assign"], flags: { "--unassign": true, "--notify": "no" }, result: ok("unassigned quietly") },
    ]);
    expect((await cli.run("jira", ["issue", "assign", "KAN-4", "--unassign", "--notify", "no"])).ok).toBe(true);
  });

  test("a flag the fixture declares a switch never takes the next token as its value", async () => {
    const cli = createFakeCli([{ command: ["issue", "assign"], switches: ["--unassign"], args: ["KAN-4"], flags: { "--unassign": true }, result: ok("unassigned") }]);
    expect((await cli.run("jira", ["issue", "assign", "--unassign", "KAN-4"])).ok).toBe(true);
  });

  test("without the switch declared, a valueless flag followed by a positional takes it as its value", async () => {
    const cli = createFakeCli([{ command: ["issue", "assign"], args: ["KAN-4"], result: ok("unassigned") }]);
    expect((await cli.run("jira", ["issue", "assign", "--unassign", "KAN-4"])).ok).toBe(false);
  });

  test("a short flag is a flag, its value the token after it", async () => {
    const cli = createFakeCli([{ command: ["issue", "get"], args: ["KAN-4"], flags: { "-s": "key" }, result: ok({ key: "KAN-4" }) }]);
    expect((await cli.run("jira", ["issue", "get", "-s", "key", "KAN-4"])).ok).toBe(true);
  });

  test("a pattern with the g flag matches every time, not every other time", async () => {
    const cli = createFakeCli([{ command: ["issue", "search"], flags: { "--jql": /KAN/g }, result: ok("hit") }]);
    for (let i = 0; i < 3; i++) expect((await cli.run("jira", ["issue", "search", "--jql", "project = KAN"])).ok).toBe(true);
  });

  // Guards determinism across tasks: fixtures are shared module-level data,
  // and a post-processor changing a result it got must not change the next one.
  test("every answer is a fresh copy of the fixture's result", async () => {
    const cli = createFakeCli([{ command: ["issue", "search"], result: ok({ issues: [{ key: "KAN-1" }] }) }]);
    const first = (await cli.run("jira", ["issue", "search"])) as { ok: true; data: { issues: unknown[] } };
    first.data.issues.push({ key: "MUTATED" });
    expect(await cli.run("jira", ["issue", "search"])).toEqual(ok({ issues: [{ key: "KAN-1" }] }));
  });

  test("a value or pattern condition fails on a flag given without a value", async () => {
    const cli = createFakeCli([{ command: ["issue", "search"], flags: { "--select": /issues/ }, result: ok("hit") }]);
    expect((await cli.run("jira", ["issue", "search", "--select"])).ok).toBe(false);
  });

  test("conditions on positional arguments, in order", async () => {
    const cli = createFakeCli([{ command: ["issue", "get"], args: ["KAN-4"], result: ok({ key: "KAN-4" }) }]);
    expect((await cli.run("jira", ["issue", "get", "KAN-4", "--select", "key"])).ok).toBe(true);
    expect((await cli.run("jira", ["issue", "get", "--select", "key", "KAN-4"])).ok).toBe(true);
    expect((await cli.run("jira", ["issue", "get", "KAN-5", "--select", "key"])).ok).toBe(false);
    expect((await cli.run("jira", ["issue", "get", "--select", "key"])).ok).toBe(false);
  });

  test("a positional pattern", async () => {
    const cli = createFakeCli([{ command: ["issue", "transitions"], args: [/^KAN-\d+$/], result: ok({ transitions: [] }) }]);
    expect((await cli.run("jira", ["issue", "transitions", "KAN-12"])).ok).toBe(true);
    expect((await cli.run("jira", ["issue", "transitions", "OPS-12"])).ok).toBe(false);
  });

  test("a result given as a function gets the command's argv, positionals and flags", async () => {
    const seen: unknown[] = [];
    const cli = createFakeCli([
      {
        command: ["issue", "get"],
        switches: ["--verbose"],
        result: (call) => {
          seen.push(call);
          return ok({ key: call.positionals[0] });
        },
      },
    ]);
    expect(await cli.run("jira", ["issue", "get", "--select", "key", "--verbose", "KAN-4"])).toEqual(ok({ key: "KAN-4" }));
    expect(seen).toEqual([
      { args: ["issue", "get", "--select", "key", "--verbose", "KAN-4"], positionals: ["KAN-4"], flags: { "--select": "key", "--verbose": true } },
    ]);
  });

  test("a function result is a fresh copy too", async () => {
    const shared = { issues: [{ key: "KAN-1" }] };
    const cli = createFakeCli([{ command: ["issue", "search"], result: () => ok(shared) }]);
    const first = (await cli.run("jira", ["issue", "search"])) as { ok: true; data: { issues: unknown[] } };
    first.data.issues.push("MUTATED");
    expect(shared.issues).toEqual([{ key: "KAN-1" }]);
  });

  test("answers a failure result as the fixture gives it", async () => {
    const failure = { ok: false as const, error: "jira exited with code 3: not logged in", exitCode: 3 };
    const cli = createFakeCli([{ command: ["issue", "search"], result: failure }]);
    expect(await cli.run("jira", ["issue", "search"])).toEqual(failure);
    expect(cli.unmatched()).toEqual([]);
  });

  test("a command no fixture answers fails like a CLI usage error and is recorded", async () => {
    const cli = createFakeCli([search]);
    const result = await cli.run("/opt/bin/jira", ["sprint", "list", "--board", "3"]);
    expect(result).toEqual({
      ok: false,
      error: "jira exited with code 2: error: unrecognized command or arguments",
      exitCode: 2,
    });
    expect(cli.unmatched()).toEqual([["sprint", "list", "--board", "3"]]);
  });

  test("records every unmatched command, in order, and a copy the caller can't change", async () => {
    const cli = createFakeCli([]);
    const args = ["a"];
    await cli.run("jira", args);
    await cli.run("jira", ["b", "--x"]);
    args.push("mutated");
    const recorded = cli.unmatched();
    expect(recorded).toEqual([["a"], ["b", "--x"]]);
    recorded.push(["mine"]);
    expect(cli.unmatched()).toEqual([["a"], ["b", "--x"]]);
  });
});
