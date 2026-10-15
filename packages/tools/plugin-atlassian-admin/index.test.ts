import { describe, it, expect } from "bun:test";
import { atlassianAdminPlugin } from "./index.ts";

/**
 * The organization's API key the CLI runs with is Mercury's own, the same
 * whoever asks: the plugin acts as Mercury, so it's offered only to someone
 * allowed to make Mercury act as itself (on the terminal, for now).
 */
describe("atlassianAdminPlugin", () => {
  it("acts as Mercury, and logs nobody in", () => {
    expect(atlassianAdminPlugin.actsAs).toBe("mercury");
    expect(atlassianAdminPlugin.build!({ model: {} as never, env: {}, log: () => {} }).login).toBeUndefined();
  });
});

// #222: the model took "Mercury" for its own name because the texts it read used
// it; the assistant's name is the app's, and the system is "the system".
describe("atlassianAdminPlugin's texts for the model", () => {
  it("never name Mercury", () => {
    const c = atlassianAdminPlugin.build!({ model: {} as never, env: {}, log: () => {} });
    const texts = [
      atlassianAdminPlugin.systemPromptFragment ?? "",
      ...(atlassianAdminPlugin.skills ?? []).flatMap((s) => [s.description, s.body]),
      ...Object.values(c.sessionTools!({ sessionKey: "s", stageConfirmation: async () => "tok", stashDisplay: () => "d1", person: null, requireLogin: async () => ({ ok: false as const, error: "x" }) }, c.postProcess)).map((t) => (typeof t.description === "string" ? t.description : "")),
    ];
    for (const text of texts) expect(text).not.toContain("Mercury");
  });
});
