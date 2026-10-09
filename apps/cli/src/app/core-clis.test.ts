/**
 * `mfw vault` and `mfw memory` run the core's maintenance CLIs by the paths in
 * `commands.ts`, resolved from the app's folder in its container. Resolved
 * from this package the same way (it depends on the core too), each path has
 * to reach an actual file: moving one in the core, or editing the constant,
 * breaks the command and this test with it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_CLI, MEMORY_CLI, VAULT_CLI } from "./commands.ts";

const cliRoot = join(import.meta.dir, "..", "..");

describe("the core's maintenance CLIs, where mfw runs them", () => {
  test.each([
    ["vault", VAULT_CLI],
    ["memory", MEMORY_CLI],
    ["identity", IDENTITY_CLI],
  ])("%s: %s exists", (_name, path) => {
    expect(path.startsWith("node_modules/@mercury-fw/core/")).toBe(true);
    expect(existsSync(join(cliRoot, path))).toBe(true);
  });
});
