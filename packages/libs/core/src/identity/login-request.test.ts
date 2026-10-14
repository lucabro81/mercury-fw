import { describe, it, expect } from "bun:test";
import { loginLinkText } from "@mercury-fw/channel-types";

describe("loginLinkText", () => {
  it("names the service the person logs in to", () => {
    expect(loginLinkText({ service: "jira", url: "https://auth.example/authorize?state=s" })).toBe("Accedi a jira");
  });

  it("falls back to a generic wording when the tool named no service", () => {
    expect(loginLinkText({ service: "", url: "https://auth.example/authorize?state=s" })).toBe("Accedi al servizio");
  });
});
