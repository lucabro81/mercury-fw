import { describe, expect, test } from "bun:test";
import { readCliCredentials } from "@mercury-fw/utils";
import pkg from "./package.json" with { type: "json" };

/**
 * The plugin's CLI keeps its login in ~/.config/atlassian-admin-cli, and the plugin declares
 * it in its package.json with the commands that set it up and check it (the CLI
 * has no logout: its login is a static API key): what `mfw credentials` runs in
 * the app's container.
 */
describe("mercury.cliCredentials", () => {
  test("declares the CLI's login folder and its commands", () => {
    expect(readCliCredentials(pkg)).toEqual({
      name: "atlassian-admin-cli",
      path: ".config/atlassian-admin-cli",
      setup: ["atlassian-admin", "init"],
      check: ["atlassian-admin", "doctor"],
    });
  });
});
