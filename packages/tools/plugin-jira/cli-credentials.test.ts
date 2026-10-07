import { describe, expect, test } from "bun:test";
import { readCliCredentials } from "@mercury-fw/utils";
import pkg from "./package.json" with { type: "json" };

/**
 * The plugin's CLI keeps its login in ~/.config/jira-cli, and the plugin declares
 * it in its package.json with the commands that set it up, check it and log an
 * identity out: what `mfw credentials` runs in the app's container.
 */
describe("mercury.cliCredentials", () => {
  test("declares the CLI's login folder and its commands", () => {
    expect(readCliCredentials(pkg)).toEqual({
      name: "jira-cli",
      path: ".config/jira-cli",
      setup: ["jira", "init"],
      userSetup: ["jira", "init", "--user-app"],
      check: ["jira", "doctor"],
      logout: ["jira", "auth", "logout"],
    });
  });
});
