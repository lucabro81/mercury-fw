import { describe, expect, test } from "bun:test";
import { detectLoginRequests, detectLoginRequired, detectPendingConfirmation, loginLinkText, type Translate } from "./index.ts";

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
