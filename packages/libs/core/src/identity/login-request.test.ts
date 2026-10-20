import { describe, it, expect } from "bun:test";
import { loginLinkText } from "@mercury-fw/channel-types";
import { englishTexts } from "../i18n/i18n.ts";

/** The core's texts in English: the keys `loginLinkText` asks for are the core's. */
const t = englishTexts().forPerson(undefined).t;

describe("loginLinkText", () => {
  it("names the service the person logs in to", () => {
    expect(loginLinkText({ service: "jira", url: "https://auth.example/authorize?state=s" }, t)).toBe("Log in to jira");
  });

  it("falls back to a generic wording when the tool named no service", () => {
    expect(loginLinkText({ service: "", url: "https://auth.example/authorize?state=s" }, t)).toBe("Log in to the service");
  });
});
