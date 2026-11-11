/**
 * `mfw vault`, `mfw identity` and `mfw memory` run the framework's
 * maintenance CLIs by the paths in `commands.ts`, resolved from the app's
 * folder in its container: the core's, and Qdrant's (`@mercury-fw/store-qdrant`)
 * for the memory. Resolved from this package the same way (it has both as
 * dependencies), each path has to reach an actual file: moving one, or editing
 * the constant, breaks the command and this test with it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_CLI, MEMORY_CLI, VAULT_CLI } from "./commands.ts";

const cliRoot = join(import.meta.dir, "..", "..");

describe("the core's maintenance CLIs, where mfw runs them", () => {
  test.each([
    ["vault", VAULT_CLI, "core"],
    ["memory", MEMORY_CLI, "store-qdrant"],
    ["identity", IDENTITY_CLI, "core"],
  ])("%s: %s exists", (_name, path, pkg) => {
    expect(path.startsWith(`node_modules/@mercury-fw/${pkg}/`)).toBe(true);
    expect(existsSync(join(cliRoot, path))).toBe(true);
  });
});
