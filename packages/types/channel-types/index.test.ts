import { describe, expect, test } from "bun:test";
import { channelOutputs, detectLoginRequests, detectLoginRequired, detectPendingConfirmation, isTurnOutputError, loginLinkText, TurnOutputError, type ChannelPlugin, type Translate } from "./index.ts";

/** The texts by key and params, so a test sees what a channel asked for. */
const echo: Translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

describe("detectPendingConfirmation", () => {
  const step = (output: unknown) => ({
    toolCalls: [{ toolCallId: "1", toolName: "jiraCommand", input: {} }],
    toolResults: [{ toolCallId: "1", toolName: "jiraCommand", output }],
    content: [],
  });

  // #281: the single choice's label was a fixed Italian "Conferma"; it's the
  // channel's own word now, in the person's language.
  test("a staging with one token is one choice with an empty label, for the channel to word", () => {
    expect(detectPendingConfirmation(step({ ok: false, pendingConfirmation: true, token: "T1", summary: "jira issue delete KAN-1" }))).toEqual({
      token: "T1",
      summary: "jira issue delete KAN-1",
      choices: [{ token: "T1", label: "" }],
    });
  });

  test("a staging with choices keeps them as the tool labelled them", () => {
    const choices = [
      { token: "T1", label: "Only this time" },
      { token: "T2", label: "Always for example.org" },
    ];
    expect(detectPendingConfirmation(step({ ok: false, pendingConfirmation: true, token: "T1", summary: "s", choices }))?.choices).toEqual(choices);
  });

  test("nothing staged, nothing found", () => {
    expect(detectPendingConfirmation(step({ ok: true }))).toBeNull();
  });
});

describe("detectLoginRequests", () => {
  /** A step whose tool calls returned `outputs`, in order. */
  const step = (...outputs: unknown[]) => ({
    toolCalls: outputs.map((_, i) => ({ toolCallId: String(i), toolName: `tool${i}`, input: {} })),
    toolResults: outputs.map((output, i) => ({ toolCallId: String(i), toolName: `tool${i}`, output })),
    content: [],
  });
  const login = (service: string, url: string) => ({ ok: false, loginRequired: true, service, authorizeUrl: url, error: "e" });

  // #211: only the first login of a step was found, so a step asking for two
  // showed one link and the second service cost the person another round.
  test("every login the step asks for, in tool-call order", () => {
    expect(detectLoginRequests(step(login("confluence", "https://c"), { ok: true }, login("bitbucket", "https://b")))).toEqual([
      { service: "confluence", url: "https://c" },
      { service: "bitbucket", url: "https://b" },
    ]);
  });

  test("the same link asked twice is one request", () => {
    expect(detectLoginRequests(step(login("jira", "https://j"), login("jira", "https://j")))).toEqual([{ service: "jira", url: "https://j" }]);
  });

  test("a login that couldn't start, with no link, isn't a request", () => {
    expect(detectLoginRequests(step({ ok: false, error: "The user isn't logged in to jira, and their login couldn't start" }))).toEqual([]);
  });

  test("a result with no service name is still a request, with an empty name", () => {
    expect(detectLoginRequests(step({ ok: false, loginRequired: true, authorizeUrl: "https://x" }))).toEqual([{ service: "", url: "https://x" }]);
  });

  test("no login, no requests", () => {
    expect(detectLoginRequests(step({ ok: true }))).toEqual([]);
  });

  test("detectLoginRequired is the first request, or null", () => {
    expect(detectLoginRequired(step({ ok: true }, login("confluence", "https://c"), login("bitbucket", "https://b")))).toEqual({
      service: "confluence",
      url: "https://c",
    });
    expect(detectLoginRequired(step({ ok: true }))).toBeNull();
  });
});

describe("loginLinkText", () => {
  test("names the service through the core's key, or says the service when there's no name", () => {
    expect(loginLinkText({ service: "jira", url: "https://x" }, echo)).toBe('core.login.link {"service":"jira"}');
    expect(loginLinkText({ service: "", url: "https://x" }, echo)).toBe("core.login.link-any");
  });
});

describe("TurnOutputError", () => {
  test("carries its code, the attempts and the last error, and says them in its message", () => {
    const err = new TurnOutputError("output-invalid", { attempts: 3, lastError: "unknown field \"titel\"" });
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("turn-output");
    expect(err.code).toBe("output-invalid");
    expect(err.attempts).toBe(3);
    expect(err.lastError).toBe('unknown field "titel"');
    expect(err.message).toBe('The turn\'s output is invalid after 3 attempts: unknown field "titel"');
  });

  test("a missing output with no error of its own says only that", () => {
    const err = new TurnOutputError("output-missing", { attempts: 1 });
    expect(err.lastError).toBeUndefined();
    expect(err.message).toBe("The turn's output is missing after 1 attempt");
  });

  test("a tool that isn't offered names it", () => {
    const err = new TurnOutputError("output-tool-unavailable", { attempts: 0, lastError: "comperio_query_build isn't offered on this turn" });
    expect(err.message).toBe("The turn's output tool is unavailable: comperio_query_build isn't offered on this turn");
  });
});

describe("isTurnOutputError", () => {
  // Recognized by its shape, not its class: a channel may run on another copy of this package.
  test("recognizes one from another copy of the package by its kind", () => {
    const foreign = Object.assign(new Error("x"), { kind: "turn-output", code: "output-missing", attempts: 2 });
    expect(isTurnOutputError(foreign)).toBe(true);
    expect(isTurnOutputError(new TurnOutputError("output-missing", { attempts: 2 }))).toBe(true);
  });

  test("anything else isn't one", () => {
    expect(isTurnOutputError(new Error("model unreachable"))).toBe(false);
    expect(isTurnOutputError({ kind: "turn-output" })).toBe(false);
    expect(isTurnOutputError(undefined)).toBe(false);
  });
});

describe("channelOutputs", () => {
  const channel = (outputs?: ChannelPlugin["outputs"]): ChannelPlugin => ({ apiVersion: 7, name: "c", build: () => undefined, ...(outputs ? { outputs } : {}) });

  test("a channel that declares nothing handles text only", () => {
    expect(channelOutputs(channel())).toEqual(["text"]);
  });

  test("a channel's declared outputs, text always among them", () => {
    expect(channelOutputs(channel(["tool", "schema"]))).toEqual(["text", "tool", "schema"]);
    expect(channelOutputs(channel(["text", "tool"]))).toEqual(["text", "tool"]);
  });
});
