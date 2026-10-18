import { describe, it, expect } from "bun:test";
import { detectPendingConfirmation } from "./pending-confirmation.ts";
import type { StepInfo } from "./step-info.ts";

function call(toolCallId: string, toolName: string, input: unknown) {
  return { toolCallId, toolName, input };
}

function result(toolCallId: string, toolName: string, output: unknown) {
  return { toolCallId, toolName, output };
}

function step(toolCalls: StepInfo["toolCalls"], toolResults: StepInfo["toolResults"]): StepInfo {
  return { toolCalls, toolResults, content: [] };
}

describe("detectPendingConfirmation", () => {
  it("returns the choices a staging offers, in order, with the first one's token as the token", () => {
    const s = step(
      [call("1", "web_fetch", { url: "https://example.org/a" })],
      [
        result("1", "web_fetch", {
          ok: false,
          pendingConfirmation: true,
          token: "TOK1",
          summary: "https://example.org/a",
          choices: [
            { token: "TOK1", label: "Solo questa volta" },
            { token: "TOK2", label: "Sempre per example.org" },
          ],
        }),
      ],
    );

    expect(detectPendingConfirmation(s)).toEqual({
      token: "TOK1",
      summary: "https://example.org/a",
      choices: [
        { token: "TOK1", label: "Solo questa volta" },
        { token: "TOK2", label: "Sempre per example.org" },
      ],
    });
  });

  it("drops a malformed choice, and falls back to the single token when none is left", () => {
    const withBad = step(
      [call("1", "t", {})],
      [result("1", "t", { ok: false, pendingConfirmation: true, token: "TOK1", choices: [{ token: "TOK1", label: "A" }, { token: 7, label: "B" }, "x"] })],
    );
    const allBad = step(
      [call("1", "t", {})],
      [result("1", "t", { ok: false, pendingConfirmation: true, token: "TOK1", choices: [{ label: "B" }] })],
    );

    expect(detectPendingConfirmation(withBad)?.choices).toEqual([{ token: "TOK1", label: "A" }]);
    expect(detectPendingConfirmation(allBad)?.choices).toEqual([{ token: "TOK1", label: "Conferma" }]);
  });

  it("extracts token and summary from any tool result flagged pendingConfirmation, regardless of tool name", () => {
    const s = step(
      [call("1", "runCommand", { command: "jira issue delete KAN-1 --confirm" })],
      [result("1", "runCommand", { ok: false, pendingConfirmation: true, token: "TOK1", summary: "jira issue delete KAN-1 --confirm", error: "..." })],
    );

    expect(detectPendingConfirmation(s)).toEqual({ token: "TOK1", summary: "jira issue delete KAN-1 --confirm", choices: [{ token: "TOK1", label: "Conferma" }] });
  });

  it("detects a confirm-required staging from a tool that isn't runCommand (the protocol is generic)", () => {
    const s = step(
      [call("1", "delete_memory", { id: "m-9" })],
      [result("1", "delete_memory", { ok: false, pendingConfirmation: true, token: "TOK9", summary: "delete memory m-9" })],
    );

    expect(detectPendingConfirmation(s)).toEqual({ token: "TOK9", summary: "delete memory m-9", choices: [{ token: "TOK9", label: "Conferma" }] });
  });

  it("returns an empty summary when the pending result carries no summary field", () => {
    const s = step(
      [call("1", "runCommand", { command: "jira issue delete KAN-1 --confirm" })],
      [result("1", "runCommand", { ok: false, pendingConfirmation: true, token: "TOK1" })],
    );

    expect(detectPendingConfirmation(s)).toEqual({ token: "TOK1", summary: "", choices: [{ token: "TOK1", label: "Conferma" }] });
  });

  it("returns null when there's no tool call at all", () => {
    const s = step([], []);
    expect(detectPendingConfirmation(s)).toBeNull();
  });

  it("returns null when the result is an ordinary success (no pendingConfirmation)", () => {
    const s = step(
      [call("1", "runCommand", { command: "jira issue search --jql x" })],
      [result("1", "runCommand", { ok: true, data: {} })],
    );

    expect(detectPendingConfirmation(s)).toBeNull();
  });

  it("returns null when the result is an ordinary failure (no pendingConfirmation)", () => {
    const s = step(
      [call("1", "runCommand", { command: "jira issue search --jql x" })],
      [result("1", "runCommand", { ok: false, error: "refusing to print without --select" })],
    );

    expect(detectPendingConfirmation(s)).toBeNull();
  });

  it("returns null when the call has no matching tool result", () => {
    const s = step([call("1", "runCommand", { command: "jira issue delete KAN-1 --confirm" })], []);

    expect(detectPendingConfirmation(s)).toBeNull();
  });

  it("returns the first confirm-required staging, in call order, when a step has more than one call", () => {
    const s = step(
      [call("1", "runCommand", { command: "jira issue search --jql x" }), call("2", "runCommand", { command: "jira issue delete KAN-1 --confirm" })],
      [
        result("1", "runCommand", { ok: true, data: {} }),
        result("2", "runCommand", { ok: false, pendingConfirmation: true, token: "TOK2", summary: "jira issue delete KAN-1 --confirm" }),
      ],
    );

    expect(detectPendingConfirmation(s)).toEqual({ token: "TOK2", summary: "jira issue delete KAN-1 --confirm", choices: [{ token: "TOK2", label: "Conferma" }] });
  });
});
