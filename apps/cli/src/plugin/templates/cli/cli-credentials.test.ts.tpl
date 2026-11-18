/**
 * Where the program keeps its login, and the commands that set it up and
 * check it: what `mfw credentials setup` and `mfw credentials check` run in
 * the app's container, declared in `package.json` (`mercury.cliCredentials`).
 */
import { describe, expect, test } from "bun:test";
import { readCliCredentials } from "@mercury-fw/utils";
import pkg from "./package.json" with { type: "json" };

describe("mercury.cliCredentials", () => {
  test("declares the login folder and its commands", () => {
    expect(readCliCredentials(pkg)).toEqual({
      name: "__BINARY__-cli",
      path: ".config/__BINARY__-cli",
      setup: ["__BINARY__", "init"],
      check: ["__BINARY__", "doctor"],
    });
  });
});
