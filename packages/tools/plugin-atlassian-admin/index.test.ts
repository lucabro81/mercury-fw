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
