import { describe, it, expect } from "bun:test";
import { createToolCorrectionExtractor, hasCorrectionCandidates } from "./extractor.ts";
import type { LanguageModel } from "ai";
import type { HookCall } from "@mercury-fw/plugin-types";

const MODEL = "fake-model" as unknown as LanguageModel;

function runCommandCall(toolCallId: string, command: string) {
  return { toolCallId, toolName: "runCommand", input: { command } };
}

function runCommandResult(toolCallId: string, output: { ok: boolean; error?: string; data?: unknown }) {
  return { toolCallId, toolName: "runCommand", output };
}

type Call = { toolCallId: string; toolName: string; input: unknown };
type Result = { toolCallId: string; toolName: string; output: { ok: boolean; error?: string; data?: unknown } };

/** A model step's calls as a finished turn reports them (`HookCall`): only the ones with a result. */
function step(toolCalls: Call[], toolResults: Result[]): HookCall[] {
  return toolCalls.flatMap((call) => {
    const result = toolResults.find((r) => r.toolCallId === call.toolCallId);
    if (result === undefined) return [];
    return [{ toolName: call.toolName, input: call.input, ok: result.output.ok, ...(result.output.error === undefined ? {} : { error: result.output.error }) }];
  });
}

describe("createToolCorrectionExtractor", () => {
  it("pairs a failed call with the next successful call for the same binary, and asks the model to describe the correction", async () => {
    const steps: HookCall[][] = [
      step(
        [runCommandCall("1", 'jira issue search --jql "x" --fields summary')],
        [runCommandResult("1", { ok: false, error: "refusing to print without --select" })],
      ),
      step(
        [runCommandCall("2", 'jira issue search --jql "x" --select issues.key')],
        [runCommandResult("2", { ok: true, data: {} })],
      ),
    ];

    let receivedPrompt: string | undefined;
    const generateObjectFn = async (params: { prompt: string }) => {
      receivedPrompt = params.prompt;
      return { object: [{ topic: "select-prefix", value: "ogni --select deve iniziare per issues." }] };
    };

    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(result).toEqual([
      { tool: "jira", topic: "select-prefix", value: "ogni --select deve iniziare per issues." },
    ]);
    expect(receivedPrompt).toContain('jira issue search --jql "x" --fields summary');
    expect(receivedPrompt).toContain("refusing to print without --select");
    expect(receivedPrompt).toContain('jira issue search --jql "x" --select issues.key');
  });

  // #112: the topic came back with the CLI's name in it about half the time
  // ("jira-select-flag" next to "select-flag"), and the note's file is
  // `<tool>-<topic>.md`: one rule, two files, one of them "jira-jira-…".
  it("asks, in English, for a topic naming the flag or subcommand, without the CLI's name", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "jira issue search --fields x")], [runCommandResult("1", { ok: false, error: "boom" })]),
      step([runCommandCall("2", "jira issue search --select x")], [runCommandResult("2", { ok: true, data: {} })]),
    ];
    let received: { instructions: string; prompt: string } | undefined;
    const generateObjectFn = async (params: { instructions: string; prompt: string }) => {
      received = params;
      return { object: [] };
    };

    await createToolCorrectionExtractor(MODEL, generateObjectFn)(steps.flat());

    expect(received?.instructions).toContain(
      '"topic" is a short, stable key for this correction: the name of the flag or subcommand it is about, in kebab-case, ' +
        'without the tool\'s name (the tool is already known: "select-flag", not "jira-select-flag"); ' +
        "a correction about the same flag as another one gets the same key.",
    );
    expect(received?.prompt).toBe("Failed command: jira issue search --fields x\nError: boom\nCorrected command (succeeded): jira issue search --select x");
    expect(`${received?.instructions} ${received?.prompt}`).not.toMatch(/comando|restituisci|correzione/i);
  });

  it("does not pair a failure with a success from a different binary", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "jira issue search --jql x")], [runCommandResult("1", { ok: false, error: "e" })]),
      step([runCommandCall("2", "bitbucket pr list")], [runCommandResult("2", { ok: true, data: {} })]),
    ];

    let calls = 0;
    const generateObjectFn = async () => {
      calls++;
      return { object: [] };
    };

    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(calls).toBe(0);
    expect(result).toEqual([]);
  });

  it("returns nothing when a failure is never followed by a success for the same binary", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "jira issue search --jql x")], [runCommandResult("1", { ok: false, error: "e" })]),
    ];

    let calls = 0;
    const generateObjectFn = async () => {
      calls++;
      return { object: [] };
    };

    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(calls).toBe(0);
    expect(result).toEqual([]);
  });

  it("returns nothing when every call already succeeded (no failure to learn from)", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "jira issue search --jql x --select-all")], [runCommandResult("1", { ok: true, data: {} })]),
    ];

    const generateObjectFn = async () => ({ object: [] });
    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(result).toEqual([]);
  });

  it("lets the model decide a candidate pair isn't a real correction, by returning an empty array", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "jira issue search --jql x")], [runCommandResult("1", { ok: false, error: "e" })]),
      step([runCommandCall("2", "jira issue search --jql y")], [runCommandResult("2", { ok: true, data: {} })]),
    ];

    const generateObjectFn = async () => ({ object: [] });
    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(result).toEqual([]);
  });

  it("normalizes the topic returned by the model", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "jira issue search --jql x")], [runCommandResult("1", { ok: false, error: "e" })]),
      step([runCommandCall("2", "jira issue search --jql x --select issues.key")], [runCommandResult("2", { ok: true, data: {} })]),
    ];

    const generateObjectFn = async () => ({ object: [{ topic: "  Select Prefix  ", value: "v" }] });
    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(result).toEqual([{ tool: "jira", topic: "select-prefix", value: "v" }]);
  });

  it("ignores tool calls that carry no command input (e.g. wiki tools)", async () => {
    const steps: HookCall[][] = [
      step(
        [{ toolCallId: "1", toolName: "read_file", input: { path: "x" } }],
        [{ toolCallId: "1", toolName: "read_file", output: { ok: false, error: "nope" } }],
      ),
      step(
        [{ toolCallId: "2", toolName: "read_file", input: { path: "y" } }],
        [{ toolCallId: "2", toolName: "read_file", output: { ok: true, data: "hi" } }],
      ),
    ];

    let calls = 0;
    const generateObjectFn = async () => {
      calls++;
      return { object: [] };
    };

    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(calls).toBe(0);
    expect(result).toEqual([]);
  });

  // Regression: the extractor once filtered on the fixed tool name "runCommand".
  // After CLI execution became plugin-owned, plugin tools are named per service
  // (jiraCommand, bitbucketCommand), so that filter silently dropped every
  // plugin CLI attempt — killing procedural learning for exactly the CLIs it
  // exists to serve. A CLI attempt is now recognized by its `command` input,
  // whatever the tool is named.
  it("learns corrections from a plugin-owned CLI tool, not just a tool literally named runCommand", async () => {
    const steps: HookCall[][] = [
      step(
        [{ toolCallId: "1", toolName: "jiraCommand", input: { command: 'jira issue search --jql "x" --fields summary' } }],
        [{ toolCallId: "1", toolName: "jiraCommand", output: { ok: false, error: "refusing to print without --select" } }],
      ),
      step(
        [{ toolCallId: "2", toolName: "jiraCommand", input: { command: 'jira issue search --jql "x" --select issues.key' } }],
        [{ toolCallId: "2", toolName: "jiraCommand", output: { ok: true, data: {} } }],
      ),
    ];
    const generateObjectFn = async () => ({ object: [{ topic: "select-prefix", value: "v" }] });

    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(result).toEqual([{ tool: "jira", topic: "select-prefix", value: "v" }]);
  });

  // The binary is derived by a plain first-token split, not full argv
  // tokenization — a whitespace-only command has no binary to group by and is
  // skipped, so it never pairs with anything.
  it("skips a runCommand call whose command is empty/whitespace-only", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "   ")], [runCommandResult("1", { ok: false, error: "e" })]),
      step([runCommandCall("2", "   ")], [runCommandResult("2", { ok: true, data: {} })]),
    ];

    let calls = 0;
    const generateObjectFn = async () => {
      calls++;
      return { object: [] };
    };

    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn);
    const result = await extract(steps.flat());

    expect(calls).toBe(0);
    expect(result).toEqual([]);
  });

  it("a generateObjectFn failure for one pair is caught and logged, doesn't stop other pairs", async () => {
    const steps: HookCall[][] = [
      step([runCommandCall("1", "jira issue search --jql x")], [runCommandResult("1", { ok: false, error: "e" })]),
      step([runCommandCall("2", "jira issue search --jql x --select issues.key")], [runCommandResult("2", { ok: true, data: {} })]),
      step([runCommandCall("3", "bitbucket pr list --bad")], [runCommandResult("3", { ok: false, error: "e2" })]),
      step([runCommandCall("4", "bitbucket pr list")], [runCommandResult("4", { ok: true, data: {} })]),
    ];

    let call = 0;
    const generateObjectFn = async () => {
      call++;
      if (call === 1) throw new Error("model unreachable");
      return { object: [{ topic: "list-flag", value: "no --bad flag" }] };
    };

    const loggedMessages: string[] = [];
    const extract = createToolCorrectionExtractor(MODEL, generateObjectFn, { log: (msg) => loggedMessages.push(msg) });
    const result = await extract(steps.flat());

    expect(result).toEqual([{ tool: "bitbucket", topic: "list-flag", value: "no --bad flag" }]);
    expect(loggedMessages.some((m) => m.includes("model unreachable"))).toBe(true);
  });
});

describe("hasCorrectionCandidates", () => {
  it("is true only for a failed command followed by a successful one of the same binary", () => {
    const fail = { toolName: "jiraCommand", input: { command: "jira x" }, ok: false, error: "no" };
    const ok = { toolName: "jiraCommand", input: { command: "jira y" }, ok: true };
    expect(hasCorrectionCandidates([fail, ok])).toBe(true);
    expect(hasCorrectionCandidates([ok, fail])).toBe(false);
    expect(hasCorrectionCandidates([fail, { ...ok, input: { command: "bitbucket y" } }])).toBe(false);
    expect(hasCorrectionCandidates([])).toBe(false);
  });
});
