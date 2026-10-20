import { describe, expect, test } from "bun:test";
import { detectPendingConfirmation, loginLinkText, type Translate } from "./index.ts";

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

describe("loginLinkText", () => {
  test("names the service through the core's key, or says the service when there's no name", () => {
    expect(loginLinkText({ service: "jira", url: "https://x" }, echo)).toBe('core.login.link {"service":"jira"}');
    expect(loginLinkText({ service: "", url: "https://x" }, echo)).toBe("core.login.link-any");
  });
});
