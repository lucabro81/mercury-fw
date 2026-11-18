/**
 * The allowlist the plugin ships: what the model may run of `__BINARY__`, and
 * which commands wait for the person's confirmation. Change these tests with
 * the allowlist, never one without the other.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { loadCliConfigFromObject, matchCommand, type CliConfig, type CliResult } from "@mercury-fw/cli-engine";
import { __CAMEL__CliConfig } from "./index.ts";

let config: CliConfig;

beforeAll(async () => {
  const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: "__BINARY__ 1.0.0" });
  const loaded = await loadCliConfigFromObject(__CAMEL__CliConfig, { runCliFn });
  if (!loaded.ok) throw new Error(`the allowlist failed to load: ${loaded.reason}`);
  config = loaded.config;
});

describe("__BINARY__.json", () => {
  test("lets the model list the items", () => {
    expect(matchCommand(["items", "list"], config)).toEqual({ kind: "allowed", prefix: ["items", "list"], mutating: false });
  });

  test("makes deleting wait for the person's confirmation", () => {
    expect(matchCommand(["items", "delete", "1"], config)).toEqual({ kind: "confirm-required", prefix: ["items", "delete"], mutating: true });
  });

  test("refuses a command it doesn't name", () => {
    expect(matchCommand(["items", "create", "x"], config)).toEqual({ kind: "not-allowed" });
  });
});
