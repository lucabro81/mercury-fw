import { describe, expect, it } from "bun:test";
import { confirmReply, RESUME_AFTER_CONFIRM } from "./index.ts";

// #269: the reply to each outcome lives here, so a channel that resolves a token
// through `resolveConfirmation` says the same as one using `confirm`.
describe("confirmReply", () => {
  it("has no reply for input that isn't a token", () => {
    expect(confirmReply({ status: "not-a-token" })).toBeNull();
  });

  it("says there's nothing pending for a token that matches nothing", () => {
    expect(confirmReply({ status: "not-found" })).toBe(
      "Nessuna conferma in sospeso per questo token — potrebbe essere scaduta, già usata, o mai esistita.",
    );
  });

  it("reports a staged action that failed, with its error", () => {
    expect(confirmReply({ status: "failed", error: "jira exited with code 1: boom" })).toBe(
      "Confermato, ma l'esecuzione è fallita: jira exited with code 1: boom",
    );
  });

  it("reports a staged action that ran, with its data", () => {
    expect(confirmReply({ status: "ok", data: { key: "KAN-1", deleted: true } })).toBe(
      'Confermato ed eseguito: {"key":"KAN-1","deleted":true}',
    );
  });

  it("answers a resumed turn with the sentence a channel recognizes", () => {
    expect(confirmReply({ status: "resume" })).toBe(RESUME_AFTER_CONFIRM);
  });
});
