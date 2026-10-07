import { describe, it, expect } from "bun:test";
import {
  stripGlobalFlags,
  matchCommand,
  formatPrefixes,
  createCliTool,
  omitDisplayForModel,
  type CliConfig,
} from "@mercury-fw/cli-engine";
import { createConfirmationStore, createStageConfirmation } from "@mercury-fw/confirm-engine";
import { createDisplayStore } from "./display-store.ts";
import type { CliResult } from "@mercury-fw/cli-engine";

describe("stripGlobalFlags", () => {
  it("removes a value-taking flag and its value from anywhere in args", () => {
    expect(
      stripGlobalFlags(["--select", "id", "issue", "search"], [{ flag: "--select", takesValue: true }]),
    ).toEqual(["issue", "search"]);
  });

  it("removes a valueless flag without consuming the next token", () => {
    expect(stripGlobalFlags(["--verbose", "issue", "search"], [{ flag: "--verbose", takesValue: false }])).toEqual([
      "issue",
      "search",
    ]);
  });

  it("leaves args untouched when no global flags are configured", () => {
    expect(stripGlobalFlags(["--select", "id", "issue", "search"], [])).toEqual([
      "--select",
      "id",
      "issue",
      "search",
    ]);
  });

  it("handles the flag appearing multiple times", () => {
    expect(
      stripGlobalFlags(
        ["--select", "a", "issue", "--select", "b", "search"],
        [{ flag: "--select", takesValue: true }],
      ),
    ).toEqual(["issue", "search"]);
  });
});

describe("matchCommand", () => {
  const config: CliConfig = {
    allowedPrefixes: [
      { prefix: ["issue", "search"], confirm: false, mutating: false },
      { prefix: ["issue", "get"], confirm: false, mutating: false },
      { prefix: ["doctor"], confirm: false, mutating: false },
      { prefix: ["issue", "delete"], confirm: true, mutating: true },
    ],
  };

  it("returns allowed for args matching a confirm:false prefix", () => {
    expect(matchCommand(["issue", "search", "--jql", "project=KAN"], config)).toEqual({
      kind: "allowed",
      prefix: ["issue", "search"],
      mutating: false,
    });
    expect(matchCommand(["doctor"], config)).toEqual({ kind: "allowed", prefix: ["doctor"], mutating: false });
  });

  it("returns allowed with mutating:true for a confirm:false, mutating:true prefix (e.g. create)", () => {
    const withCreate: CliConfig = {
      allowedPrefixes: [
        ...config.allowedPrefixes,
        { prefix: ["issue", "create"], confirm: false, mutating: true },
      ],
    };
    expect(matchCommand(["issue", "create", "--project", "KAN"], withCreate)).toEqual({
      kind: "allowed",
      prefix: ["issue", "create"],
      mutating: true,
    });
  });

  it("returns confirm-required for args matching a confirm:true prefix", () => {
    expect(matchCommand(["issue", "delete", "KAN-1"], config)).toEqual({
      kind: "confirm-required",
      prefix: ["issue", "delete"],
      mutating: true,
    });
  });

  it("returns not-allowed for args matching no configured prefix", () => {
    expect(matchCommand(["issue", "create", "--project", "KAN"], config)).toEqual({ kind: "not-allowed" });
  });

  it("always allows --help, even for an otherwise-disallowed shape, with no matched prefix", () => {
    expect(matchCommand(["issue", "create", "--help"], config)).toEqual({ kind: "allowed", prefix: [], mutating: false });
    expect(matchCommand(["--help"], config)).toEqual({ kind: "allowed", prefix: [], mutating: false });
  });

  it("applies a config's globalFlags before matching prefixes", () => {
    const withFlags: CliConfig = {
      allowedPrefixes: [{ prefix: ["issue", "search"], confirm: false, mutating: false }],
      globalFlags: [{ flag: "--select", takesValue: true }],
    };
    expect(matchCommand(["--select", "id", "issue", "search"], withFlags)).toEqual({
      kind: "allowed",
      prefix: ["issue", "search"],
      mutating: false,
    });
    expect(matchCommand(["--select", "id", "issue", "delete"], withFlags)).toEqual({ kind: "not-allowed" });
  });

  it("uses args as-is when a config has no globalFlags", () => {
    expect(matchCommand(["--select", "id", "issue", "search"], config)).toEqual({ kind: "not-allowed" });
  });

  // Proves the allowlist logic is genuinely generic across CLIs, not just
  // "jira with extra steps" — two configs with unrelated prefix sets must
  // each only allow their own shapes.
  it("evaluates independently per config, proving the logic generalizes across CLIs", () => {
    const jiraLike: CliConfig = {
      allowedPrefixes: [{ prefix: ["issue", "search"], confirm: false, mutating: false }],
    };
    const chatLike: CliConfig = {
      allowedPrefixes: [{ prefix: ["spaces", "list"], confirm: false, mutating: false }],
    };

    expect(matchCommand(["issue", "search"], jiraLike)).toEqual({ kind: "allowed", prefix: ["issue", "search"], mutating: false });
    expect(matchCommand(["spaces", "list"], jiraLike)).toEqual({ kind: "not-allowed" });

    expect(matchCommand(["spaces", "list"], chatLike)).toEqual({ kind: "allowed", prefix: ["spaces", "list"], mutating: false });
    expect(matchCommand(["issue", "search"], chatLike)).toEqual({ kind: "not-allowed" });
  });
});

describe("omitDisplayForModel", () => {
  it("strips the top-level display channel when present", () => {
    expect(
      omitDisplayForModel({ ok: true, data: { issues: [] }, display: { type: "issue-list", items: ["MER-1\nhttps://x"] } }),
    ).toEqual({ ok: true, data: { issues: [] } });
  });

  it("leaves a model-facing note in data untouched (it is not the display channel)", () => {
    const output = { ok: true, data: { formattedListNote: "could not build a list, retry with --select-all" } };
    expect(omitDisplayForModel(output)).toEqual(output);
  });

  it("leaves a result with no display untouched", () => {
    const output = { ok: false, error: "boom" };
    expect(omitDisplayForModel(output)).toEqual(output);
  });

  it("leaves a successful result that carries no display untouched", () => {
    const output = { ok: true, data: { issues: [{ key: "MER-1" }] } };
    expect(omitDisplayForModel(output)).toEqual(output);
  });

  it("leaves non-object output (e.g. a plain error string) untouched", () => {
    expect(omitDisplayForModel("not an object")).toBe("not an object");
    expect(omitDisplayForModel(null)).toBe(null);
  });

  it("keeps data and every other top-level field intact while dropping display", () => {
    expect(
      omitDisplayForModel({
        ok: true,
        data: { issues: [{ key: "MER-1" }], total: 1 },
        display: { type: "issue-list", items: ["MER-1\nhttps://x"] },
      }),
    ).toEqual({ ok: true, data: { issues: [{ key: "MER-1" }], total: 1 } });
  });

  it("does not mutate the input object", () => {
    const output = { ok: true, data: { issues: [] }, display: { type: "issue-list", items: ["MER-1\nhttps://x"] } };
    const snapshot = JSON.parse(JSON.stringify(output));
    omitDisplayForModel(output);
    expect(output).toEqual(snapshot);
  });
});

describe("formatPrefixes", () => {
  it("joins each prefix's parts with a space, and prefixes with a comma", () => {
    expect(
      formatPrefixes([
        ["issue", "search"],
        ["issue", "get"],
        ["doctor"],
      ]),
    ).toBe("issue search, issue get, doctor");
  });

  it("returns an empty string for an empty prefix list", () => {
    expect(formatPrefixes([])).toBe("");
  });
});

describe("createCliTool", () => {
  const jiraConfig: CliConfig = {
    allowedPrefixes: [
      { prefix: ["issue", "search"], confirm: false, mutating: false },
      { prefix: ["issue", "get"], confirm: false, mutating: false },
      { prefix: ["doctor"], confirm: false, mutating: false },
      { prefix: ["issue", "delete"], confirm: true, mutating: true },
    ],
  };

  // A no-op stageConfirmation is enough for tests that don't exercise the
  // confirm-required branch — createCliTool's signature requires it, but only
  // the confirm-required tests below actually stage anything.
  function defaultOpts() {
    return {
      stageConfirmation: createStageConfirmation({
        store: createConfirmationStore(),
        sessionKey: "test-session",
        owner: "static:user-x",
        vaultPath: "/vault",
        writeConfirmationNoteFn: async () => {},
      }),
    };
  }

  // Shared by the confirm-required tests below, which stage into a real store
  // (bound here as "terminal") so they can then `take` and inspect what was
  // staged. The note-writing side effect is covered in confirmation-staging's
  // own tests, so a no-op writer is enough here.
  function confirmOpts(store: ReturnType<typeof createConfirmationStore>) {
    return {
      stageConfirmation: createStageConfirmation({
        store,
        sessionKey: "terminal",
        owner: "static:user-x",
        vaultPath: "/vault",
        writeConfirmationNoteFn: async () => {},
      }),
    };
  }

  it("execute parses the command and calls runCliFn with the exact binary and args for an allowed command", async () => {
    let receivedBinary: string | undefined;
    let receivedArgs: string[] | undefined;
    const fakeResult: CliResult = { ok: true, data: { issues: [] } };
    const runCliFn = async (binary: string, args: string[]) => {
      receivedBinary = binary;
      receivedArgs = args;
      return fakeResult;
    };

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
    const result = await runCommand.execute(
      { command: 'jira issue search --jql "project = KAN"' },
      {} as never,
    );

    expect(receivedBinary).toBe("jira");
    expect(receivedArgs).toEqual(["issue", "search", "--jql", "project = KAN"]);
    expect(result).toEqual(fakeResult);
  });

  describe("runCommand description", () => {
    const runCliFn = async () => ({ ok: true as const, data: {} });

    // Regression (guards the hardcoded-example bug): the description used to
    // embed a fixed `jira issue search --jql ...` example even on an instance
    // where Jira isn't enabled — misleading the model. It must never name a CLI
    // that isn't in `configs`.
    it("does not name a CLI that isn't configured on this instance", () => {
      const { runCommand } = createCliTool(runCliFn, { "google-chat": jiraConfig }, defaultOpts());
      expect(runCommand.description).not.toContain("jira");
    });

    it("anchors its example on an enabled binary using the dynamic shape", () => {
      // Assert the whole dynamic template, not just the presence of "jira": the
      // old hardcoded string was `jira issue search --jql "project = KAN"`, so
      // matching `jira <subcommand> --flag value` proves the example is built
      // from the config key, not a static literal that happens to say "jira".
      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
      expect(runCommand.description).toContain("jira <subcommand> --flag value");
    });

    it("falls back to a neutral placeholder when no CLI is configured", () => {
      const { runCommand } = createCliTool(runCliFn, {}, defaultOpts());
      expect(runCommand.description).toContain("<binary>");
    });
  });

  describe("postProcess", () => {
    type Cmd = { binary: string; args: string[]; prefix: string[] };

    it("applies the post-processor to a successful result", async () => {
      const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: { issues: [] } });
      const postProcess = (_cmd: Cmd, result: CliResult): CliResult =>
        result.ok ? { ok: true, data: result.data, display: { type: "issue-list", items: [] } } : result;

      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, { ...defaultOpts(), postProcess });
      const result = await runCommand.execute({ command: 'jira issue search --jql "project = KAN"' }, {} as never);

      expect(result).toEqual({ ok: true, data: { issues: [] }, display: { type: "issue-list", items: [] } });
    });

    it("passes the binary, the args and the matched allowlist prefix to the post-processor", async () => {
      const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: { issues: [] } });
      let received: Cmd | undefined;
      const postProcess = (cmd: Cmd, result: CliResult): CliResult => {
        received = cmd;
        return result;
      };

      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, { ...defaultOpts(), postProcess });
      await runCommand.execute({ command: 'jira issue search --jql "project = KAN"' }, {} as never);

      expect(received).toEqual({
        binary: "jira",
        args: ["issue", "search", "--jql", "project = KAN"],
        prefix: ["issue", "search"],
      });
    });

    // The plugin decides from the prefix, so it must be the allowlist entry,
    // not the raw argv head — a global flag in front must not hide it.
    it("reports the matched prefix even when a global flag precedes the subcommand", async () => {
      const withFlags: CliConfig = {
        allowedPrefixes: [{ prefix: ["issue", "search"], confirm: false, mutating: false }],
        globalFlags: [{ flag: "--select", takesValue: true }],
      };
      let received: Cmd | undefined;
      const postProcess = (cmd: Cmd, result: CliResult): CliResult => {
        received = cmd;
        return result;
      };

      const { runCommand } = createCliTool(async () => ({ ok: true, data: {} }), { jira: withFlags }, {
        ...defaultOpts(),
        postProcess,
      });
      await runCommand.execute({ command: "jira --select key issue search" }, {} as never);

      expect(received?.prefix).toEqual(["issue", "search"]);
      expect(received?.args).toEqual(["--select", "key", "issue", "search"]);
    });

    it("runs for every allowed command, handing --help an empty prefix", async () => {
      const prefixes: string[][] = [];
      const postProcess = (cmd: Cmd, result: CliResult): CliResult => {
        prefixes.push(cmd.prefix);
        return result;
      };
      const { runCommand } = createCliTool(async () => ({ ok: true, data: "ok" }), { jira: jiraConfig }, {
        ...defaultOpts(),
        postProcess,
      });

      await runCommand.execute({ command: "jira doctor" }, {} as never);
      await runCommand.execute({ command: "jira issue get KAN-1" }, {} as never);
      await runCommand.execute({ command: "jira issue search --help" }, {} as never);

      expect(prefixes).toEqual([["doctor"], ["issue", "get"], []]);
    });

    it("leaves the result untouched when no post-processor is supplied", async () => {
      const fakeResult: CliResult = { ok: true, data: { issues: [] } };
      const runCliFn = async (): Promise<CliResult> => fakeResult;

      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
      const result = await runCommand.execute({ command: 'jira issue search --jql "project = KAN"' }, {} as never);

      expect(result).toEqual(fakeResult);
    });

    it("wires toModelOutput to drop the display channel from what the model sees, while execute's own return keeps it", async () => {
      const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: { issues: [] } });
      const postProcess = (_cmd: Cmd, result: CliResult): CliResult =>
        result.ok ? { ok: true, data: result.data, display: { type: "issue-list", items: ["no issues"] } } : result;

      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, { ...defaultOpts(), postProcess });
      const result = await runCommand.execute({ command: 'jira issue search --jql "project = KAN"' }, {} as never);
      expect(result).toEqual({ ok: true, data: { issues: [] }, display: { type: "issue-list", items: ["no issues"] } });

      const modelOutput = await runCommand.toModelOutput?.({
        toolCallId: "call-1",
        input: { command: 'jira issue search --jql "project = KAN"' },
        output: result,
      } as never);
      expect(modelOutput).toEqual({ type: "json", value: { ok: true, data: { issues: [] } } });
    });

    it("lets a post-processor turn a successful CLI result into an error (e.g. missing required fields)", async () => {
      const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: { issues: [{ key: "KAN-1" }] } });
      const postProcess = (): CliResult => ({ ok: false, error: "missing required field: summary" });

      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, { ...defaultOpts(), postProcess });
      const result = await runCommand.execute({ command: 'jira issue search --jql "project = KAN"' }, {} as never);

      expect(result).toEqual({ ok: false, error: "missing required field: summary" });
    });
  });

  // Relocated originally from jira.test.ts's createJiraTool coverage: lists
  // the valid prefixes in the rejection error, to help a small model
  // self-correct in one step instead of needing a --help round trip.
  it("execute does not call runCliFn for a disallowed subcommand, and lists the valid prefixes", async () => {
    let called = false;
    const runCliFn = async (): Promise<CliResult> => {
      called = true;
      return { ok: true, data: {} };
    };

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
    const result = (await runCommand.execute(
      { command: "jira issue create --project KAN" },
      {} as never,
    )) as CliResult;

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not permitted");
      expect(result.error).toContain("issue search");
      expect(result.error).toContain("issue get");
      expect(result.error).toContain("doctor");
    }
  });

  // Regression for #174: the CLIs act as the person `--user <id>` names, and
  // matching only looks at the prefix, so `issue get X --user bob` ran as bob
  // for whoever asked. The identity is never the model's to pick.
  describe("refuses --user written by the model", () => {
    const store = () => createConfirmationStore();
    for (const command of [
      "jira issue get KAN-1 --user bob",
      "jira issue get KAN-1 --user=bob",
      "jira --user bob issue get KAN-1",
      "jira issue get KAN-1 --user bob --help",
      "jira issue delete KAN-1 --user bob",
    ]) {
      it(`refuses "${command}" without running or staging anything`, async () => {
        let called = false;
        const runCliFn = async (): Promise<CliResult> => {
          called = true;
          return { ok: true, data: {} };
        };
        const confirmations = store();
        const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, confirmOpts(confirmations));
        const result = (await runCommand.execute({ command }, {} as never)) as CliResult;

        expect(called).toBe(false);
        expect(confirmations.pending("static:user-x")).toEqual([]);
        expect(result).toEqual({
          ok: false,
          error:
            "--user is not allowed: Mercury decides whose account a command runs as, never the command itself. Run it again without --user.",
        });
      });
    }

    // The CLIs parse `--user` wherever it stands, so a value that is exactly
    // `--user` is refused too rather than guessed at.
    it("refuses a value that is exactly --user", async () => {
      let called = false;
      const runCliFn = async (): Promise<CliResult> => {
        called = true;
        return { ok: true, data: {} };
      };
      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
      const result = (await runCommand.execute({ command: 'jira issue search --jql "--user"' }, {} as never)) as CliResult;
      expect(called).toBe(false);
      expect(result.ok).toBe(false);
    });

    it("still runs a command whose value merely contains the word user", async () => {
      let receivedArgs: string[] | undefined;
      const runCliFn = async (_binary: string, args: string[]): Promise<CliResult> => {
        receivedArgs = args;
        return { ok: true, data: {} };
      };
      const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
      await runCommand.execute({ command: 'jira issue search --jql "text ~ \\"--user-agent\\""' }, {} as never);
      expect(receivedArgs).toEqual(["issue", "search", "--jql", 'text ~ "--user-agent"']);
    });
  });

  // #176: a plugin acting as the person runs every command as them.
  describe("as the person the turn is for", () => {
    /** A runCli that records the args of each run and answers with `result`. */
    function recording(result: CliResult = { ok: true, data: {} }) {
      const runs: string[][] = [];
      const runCliFn = async (_binary: string, args: string[]): Promise<CliResult> => {
        runs.push(args);
        return result;
      };
      return { runs, runCliFn };
    }

    it("appends --user with the id the CLI knows the person by", async () => {
      const r = recording();
      const { runCommand } = createCliTool(r.runCliFn, { jira: jiraConfig }, { ...defaultOpts(), person: { key: "static:alice" } });
      await runCommand.execute({ command: "jira issue get KAN-1 --select key" }, {} as never);
      expect(r.runs).toEqual([["issue", "get", "KAN-1", "--select", "key", "--user", "static:alice"]]);
    });

    it("maps a key the CLIs would refuse through cliUserId", async () => {
      const r = recording();
      const { runCommand } = createCliTool(r.runCliFn, { jira: jiraConfig }, { ...defaultOpts(), person: { key: "oidc:Alice" } });
      await runCommand.execute({ command: "jira doctor" }, {} as never);
      expect(r.runs[0]?.slice(0, 2)).toEqual(["doctor", "--user"]);
      expect(r.runs[0]?.[2]).toMatch(/^oidc:[0-9a-f]{32}$/);
    });

    it("runs a staged confirmation as the same person", async () => {
      const r = recording();
      const store = createConfirmationStore({ tokenFn: () => "TOK1" });
      const { runCommand } = createCliTool(r.runCliFn, { jira: jiraConfig }, { ...confirmOpts(store), person: { key: "static:alice" } });
      await runCommand.execute({ command: "jira issue delete KAN-1" }, {} as never);
      expect(r.runs).toEqual([]);
      await store.take("terminal", "static:user-x", "TOK1")?.run();
      expect(r.runs).toEqual([["issue", "delete", "KAN-1", "--confirm", "--user", "static:alice"]]);
    });

    it("without a person (the terminal) runs as the service, without --user", async () => {
      const r = recording();
      const { runCommand } = createCliTool(r.runCliFn, { jira: jiraConfig }, { ...defaultOpts(), person: null });
      await runCommand.execute({ command: "jira doctor" }, {} as never);
      expect(r.runs).toEqual([["doctor"]]);
    });

    it("a person who isn't logged in (exit code 3) gets the login the tool asks for", async () => {
      const r = recording({ ok: false, error: "jira exited with code 3: not logged in", exitCode: 3 });
      let asked = 0;
      const login = { ok: false as const, loginRequired: true as const, service: "jira", authorizeUrl: "https://x", error: "log in" };
      const { runCommand } = createCliTool(r.runCliFn, { jira: jiraConfig }, {
        ...defaultOpts(),
        person: { key: "static:alice" },
        requireLogin: async () => {
          asked++;
          return login;
        },
      });
      expect(await runCommand.execute({ command: "jira issue get KAN-1" }, {} as never)).toEqual(login);
      expect(asked).toBe(1);
    });

    // Review of #176: the link carries the login's state, the only credential
    // of the public callback. The channel shows it; the model never sees it.
    it("keeps the login link out of what the model sees, while execute's own return keeps it for the channel", async () => {
      const r = recording({ ok: false, error: "jira exited with code 3: x", exitCode: 3 });
      const login = { ok: false as const, loginRequired: true as const, service: "jira", authorizeUrl: "https://auth?state=s", error: "log in" };
      const { runCommand } = createCliTool(r.runCliFn, { jira: jiraConfig }, {
        ...defaultOpts(),
        person: { key: "static:alice" },
        requireLogin: async () => login,
      });
      const result = await runCommand.execute({ command: "jira doctor" }, {} as never);
      expect(result).toEqual(login);
      const modelOutput = await runCommand.toModelOutput?.({ toolCallId: "c", input: { command: "jira doctor" }, output: result } as never);
      expect(modelOutput).toEqual({ type: "json", value: { ok: false, loginRequired: true, service: "jira", error: "log in" } });
    });

    it("any other failure, or the service not being logged in, is returned as it is", async () => {
      for (const [person, exitCode] of [[{ key: "static:alice" }, 1], [null, 3]] as const) {
        const failure: CliResult = { ok: false, error: `jira exited with code ${exitCode}: x`, exitCode };
        const r = recording(failure);
        let asked = 0;
        const { runCommand } = createCliTool(r.runCliFn, { jira: jiraConfig }, {
          ...defaultOpts(),
          person,
          requireLogin: async () => {
            asked++;
            return { ok: false, error: "x" };
          },
        });
        expect(await runCommand.execute({ command: "jira doctor" }, {} as never)).toEqual(failure);
        expect(asked).toBe(0);
      }
    });
  });

  // The confirm-required branch is distinct from "not permitted": the
  // shape IS recognized, but instead of running it, it's staged in the
  // ConfirmationStore under the tool's own sessionKey and a structured
  // `token` is handed back — runCliFn only runs later, once that token
  // comes back through whatever channel-specific confirmation mechanism
  // the caller's provider uses (see confirm-flow.ts and
  // terminal-provider.ts/google-chat-provider.ts).
  it("execute stages a confirm-required command instead of running it, returning token + summary", async () => {
    let called = false;
    const runCliFn = async (): Promise<CliResult> => {
      called = true;
      return { ok: true, data: {} };
    };
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, confirmOpts(store));
    const result = (await runCommand.execute(
      { command: "jira issue delete KAN-1 --confirm" },
      {} as never,
    )) as CliResult & { pendingConfirmation?: true; token?: string; summary?: string };

    // the CLI isn't run at stage time — only later, when the token comes back
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.pendingConfirmation).toBe(true);
    expect(result.token).toBe("TOK1");
    // summary is the raw command the model wrote — what a channel shows in its
    // confirmation UI (see detectPendingConfirmation / the providers)
    expect(result.summary).toBe("jira issue delete KAN-1 --confirm");
    if (!result.ok) {
      expect(result.error).not.toContain("not permitted");
    }

    // the staged action is an opaque thunk described by the normalized argv;
    // running it is what finally invokes the CLI with the FULL argv
    const staged = store.take("terminal", "static:user-x", "TOK1");
    expect(staged?.describe).toBe("jira issue delete KAN-1 --confirm");
    expect(staged?.requestedAt).toEqual(expect.any(String));
    await staged?.run();
    expect(called).toBe(true);
  });

  // Regression test: the model asked for "jira issue delete MER-19"
  // (without --confirm) in a real conversation. Mercury staged it exactly
  // as typed, and once the user confirmed via card, execution failed
  // because jira-cli itself refuses to delete without its own --confirm
  // flag — a completely separate safety net from Mercury's own token, and
  // one the model can't be relied on to remember. Staging must add it
  // whenever it's missing, so the confirmed command actually succeeds.
  it("adds --confirm to the staged args when the model omitted it", async () => {
    let ranArgs: string[] | undefined;
    const runCliFn = async (_binary: string, args: string[]): Promise<CliResult> => {
      ranArgs = args;
      return { ok: true, data: {} };
    };
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, confirmOpts(store));
    await runCommand.execute({ command: "jira issue delete MER-19" }, {} as never);

    const staged = store.take("terminal", "static:user-x", "TOK1");
    expect(staged?.describe).toBe("jira issue delete MER-19 --confirm");
    await staged?.run();
    expect(ranArgs).toEqual(["issue", "delete", "MER-19", "--confirm"]);
  });

  it("does not duplicate --confirm when the model already included it", async () => {
    let ranArgs: string[] | undefined;
    const runCliFn = async (_binary: string, args: string[]): Promise<CliResult> => {
      ranArgs = args;
      return { ok: true, data: {} };
    };
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, confirmOpts(store));
    await runCommand.execute({ command: "jira issue delete MER-19 --confirm" }, {} as never);

    const staged = store.take("terminal", "static:user-x", "TOK1");
    expect(staged?.describe).toBe("jira issue delete MER-19 --confirm");
    await staged?.run();
    expect(ranArgs).toEqual(["issue", "delete", "MER-19", "--confirm"]);
  });

  // Confirming is now channel-specific (a card button on Google Chat, a
  // typed token on the terminal — see terminal-provider.ts/google-chat-
  // provider.ts) instead of a fixed instruction the model relays as text.
  // The tool result stays channel-neutral: it hands over the structured
  // `token`, but must not dictate literal wording ("reply `conferma X`")
  // that would be wrong on a channel using a button instead.
  it("does not instruct the model to relay a literal 'conferma <token>' reply — that's channel-specific now", async () => {
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: {} });
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, confirmOpts(store));
    const result = (await runCommand.execute(
      { command: "jira issue delete KAN-1 --confirm" },
      {} as never,
    )) as CliResult & { pendingConfirmation?: true; token?: string };

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).not.toContain("conferma");
    }
  });

  it("stages a confirm-required command under the tool's own sessionKey, not a different one", async () => {
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: {} });
    const store = createConfirmationStore({ tokenFn: () => "TOK1" });

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, confirmOpts(store));
    await runCommand.execute({ command: "jira issue delete KAN-1 --confirm" }, {} as never);

    expect(store.take("some-other-session", "static:user-x", "TOK1")).toBeNull();
  });

  // The "not permitted" message must only advertise prefixes that will
  // actually run — otherwise the model would keep retrying a shape that's
  // recognized but always rejected for a different reason.
  it("excludes confirm-gated prefixes from the 'not permitted' message's valid-commands list", async () => {
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: {} });
    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
    const result = (await runCommand.execute(
      { command: "jira issue create --project KAN" },
      {} as never,
    )) as CliResult;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("issue delete");
    }
  });

  it("execute does not call runCliFn for a binary with no configured CliConfig, and lists what's available", async () => {
    let called = false;
    const runCliFn = async (): Promise<CliResult> => {
      called = true;
      return { ok: true, data: {} };
    };

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
    const result = (await runCommand.execute(
      { command: "bitbucket pr list" },
      {} as never,
    )) as CliResult;

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bitbucket");
      expect(result.error).toContain("jira");
    }
  });

  it("execute does not call runCliFn for an unparseable command, and surfaces the parser's own error", async () => {
    let called = false;
    const runCliFn = async (): Promise<CliResult> => {
      called = true;
      return { ok: true, data: {} };
    };

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
    const result = (await runCommand.execute(
      { command: 'jira issue search --jql "project = KAN' },
      {} as never,
    )) as CliResult;

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unterminated");
    }
  });

  it("execute propagates a runCliFn error result as-is, never throws", async () => {
    const runCliFn = async (): Promise<CliResult> => ({
      ok: false,
      error: "jira exited with code 1: boom",
    });

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
    const result = await runCommand.execute({ command: "jira issue get KAN-1" }, {} as never);

    expect(result).toEqual({ ok: false, error: "jira exited with code 1: boom" });
  });

  it("rejects an empty command at the schema level", () => {
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: {} });
    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig }, defaultOpts());
    const schema = runCommand.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ command: "" }).success).toBe(false);
    expect(schema.safeParse({ command: "jira doctor" }).success).toBe(true);
  });

  // Proves this isn't "jira with extra steps": a second, unrelated CliConfig
  // in the same map must route independently, on the same tool.
  it("routes correctly across multiple configured CLIs on the same tool", async () => {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const runCliFn = async (binary: string, args: string[]): Promise<CliResult> => {
      calls.push({ binary, args });
      return { ok: true, data: {} };
    };
    const chatConfig: CliConfig = {
      allowedPrefixes: [{ prefix: ["spaces", "list"], confirm: false, mutating: false }],
    };

    const { runCommand } = createCliTool(runCliFn, { jira: jiraConfig, "google-chat": chatConfig }, defaultOpts());
    await runCommand.execute({ command: "jira doctor" }, {} as never);
    await runCommand.execute({ command: "google-chat spaces list" }, {} as never);

    expect(calls).toEqual([
      { binary: "jira", args: ["doctor"] },
      { binary: "google-chat", args: ["spaces", "list"] },
    ]);
  });
});

// The user-facing artifact a post-processor renders is no longer force-appended
// at finalize: execute stashes it in the display store and hands the model only
// a `displayRef` (so the model can choose to `present` it) — never the content.
describe("createCliTool display staging", () => {
  const searchConfig: CliConfig = {
    allowedPrefixes: [{ prefix: ["issue", "search"], confirm: false, mutating: false }],
  };
  const doctorConfig: CliConfig = {
    allowedPrefixes: [{ prefix: ["doctor"], confirm: false, mutating: false }],
  };
  const renderingPostProcess = (_cmd: unknown, result: CliResult): CliResult =>
    result.ok ? { ok: true, data: result.data, display: { type: "issue-list", items: ["MER-1\nhttps://x"] } } : result;
  function noopStage() {
    return createStageConfirmation({
      store: createConfirmationStore(),
      sessionKey: "terminal",
      owner: "static:user-x",
      vaultPath: "/vault",
      writeConfirmationNoteFn: async () => {},
    });
  }
  function opts(displayStore: ReturnType<typeof createDisplayStore>) {
    return {
      stageConfirmation: noopStage(),
      stashDisplay: (artifact: string) => displayStore.stash("terminal", artifact),
    };
  }

  it("stashes the rendered artifact and returns its ref on the result", async () => {
    const displayStore = createDisplayStore({ refFn: () => "d1" });
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: { issues: [{ key: "MER-1" }] } });
    const { runCommand } = createCliTool(runCliFn, { jira: searchConfig }, {
      ...opts(displayStore),
      postProcess: renderingPostProcess,
    });

    const result = (await runCommand.execute({ command: 'jira issue search --jql "x"' }, {} as never)) as {
      displayRef?: string;
    };
    expect(result.displayRef).toBe("d1");
    // the ref really points at the rendered artifact
    expect(displayStore.surface("terminal", "d1")).toBe(true);
    expect(displayStore.takeSurfaced("terminal")).toEqual(["MER-1\nhttps://x"]);
  });

  it("hands the model the displayRef but never the rendered display content", async () => {
    const displayStore = createDisplayStore({ refFn: () => "d1" });
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: { issues: [] } });
    const { runCommand } = createCliTool(runCliFn, { jira: searchConfig }, {
      ...opts(displayStore),
      postProcess: renderingPostProcess,
    });

    const result = await runCommand.execute({ command: 'jira issue search --jql "x"' }, {} as never);
    const modelOutput = await runCommand.toModelOutput?.({
      toolCallId: "c",
      input: { command: 'jira issue search --jql "x"' },
      output: result,
    } as never);
    expect(modelOutput).toEqual({ type: "json", value: { ok: true, data: { issues: [] }, displayRef: "d1" } });
  });

  it("does not stash or add a displayRef for a result with no display", async () => {
    const displayStore = createDisplayStore({ refFn: () => "d1" });
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: "ok" });
    const { runCommand } = createCliTool(runCliFn, { jira: doctorConfig }, opts(displayStore));

    const result = (await runCommand.execute({ command: "jira doctor" }, {} as never)) as { displayRef?: string };
    expect(result.displayRef).toBeUndefined();
    expect(displayStore.surface("terminal", "d1")).toBe(false);
  });

  it("does not stash when the display carries no string items (structured, no formatter applied)", async () => {
    const displayStore = createDisplayStore({ refFn: () => "d1" });
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: {} });
    const structuredPostProcess = (_cmd: unknown, result: CliResult): CliResult =>
      result.ok ? { ok: true, data: result.data, display: { type: "issue-list", items: [{ key: "MER-1" }] } } : result;
    const { runCommand } = createCliTool(runCliFn, { jira: searchConfig }, {
      ...opts(displayStore),
      postProcess: structuredPostProcess,
    });

    const result = (await runCommand.execute({ command: 'jira issue search --jql "x"' }, {} as never)) as {
      displayRef?: string;
    };
    expect(result.displayRef).toBeUndefined();
  });

  it("leaves execute's return unchanged (no displayRef) when no stashDisplay is wired", async () => {
    const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: { issues: [] } });
    const { runCommand } = createCliTool(runCliFn, { jira: searchConfig }, {
      stageConfirmation: noopStage(),
      postProcess: renderingPostProcess,
    });

    const result = await runCommand.execute({ command: 'jira issue search --jql "x"' }, {} as never);
    expect(result).toEqual({ ok: true, data: { issues: [] }, display: { type: "issue-list", items: ["MER-1\nhttps://x"] } });
  });
});
