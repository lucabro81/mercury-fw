import { describe, it, expect, beforeAll } from "bun:test";
import { loadCliConfigFromObject, matchCommand, type CliConfig, type CliResult } from "@mercury-fw/cli-engine";
import { confluenceCliConfig } from "./index.ts";

/**
 * Safety net for the real, shipped `@mercury-fw/plugin-confluence` allowlist:
 * the plugin is read-only, so every command it lets through reads, and the
 * CLI's writing commands (pages, templates) and its login commands never run.
 * Loading the shipped config, not a fixture, means an edit to it that breaks
 * one of these guarantees is caught here.
 */

let config: CliConfig;

beforeAll(async () => {
  const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: "confluence 3.1.0" });
  const result = await loadCliConfigFromObject(confluenceCliConfig, { runCliFn });
  if (!result.ok) {
    throw new Error(`@mercury-fw/plugin-confluence config failed to load: ${result.reason}`);
  }
  config = result.config;
});

describe("@mercury-fw/plugin-confluence allowlist", () => {
  it("allows every read command", () => {
    const read = (args: string[], prefix: string[]) =>
      expect(matchCommand(args, config)).toEqual({ kind: "allowed", prefix, mutating: false });
    read(["page", "search", "--cql", 'type = page AND space = "ENG"', "--select", "results.content.title"], ["page", "search"]);
    read(["page", "get", "123456", "--select", "title,body.markdown.value"], ["page", "get"]);
    read(["page", "children", "123456", "--select", "results.title"], ["page", "children"]);
    read(["page", "ancestors", "123456", "--select", "results.title"], ["page", "ancestors"]);
    read(["page", "comments", "123456", "--select", "results.body.markdown.value"], ["page", "comments"]);
    read(["space", "list", "--select", "results.key"], ["space", "list"]);
    read(["space", "get", "ENG"], ["space", "get"]);
    read(["doctor"], ["doctor"]);
    read(["auth", "whoami"], ["auth", "whoami"]);
  });

  it("allows a read command when --select comes before it", () => {
    expect(matchCommand(["--select", "title", "page", "get", "123456"], config)).toEqual({
      kind: "allowed",
      prefix: ["page", "get"],
      mutating: false,
    });
  });

  it("refuses the CLI's writing commands", () => {
    for (const args of [
      ["page", "create", "--space-id", "1", "--title", "x", "--body", "<p>x</p>"],
      ["page", "update", "123456", "--title", "x"],
      ["page", "delete", "123456", "--confirm"],
      ["page", "delete", "123456", "--confirm", "--purge"],
      ["template", "create", "--name", "x", "--body", "<p>x</p>"],
      ["template", "update", "1", "--name", "x"],
      ["template", "delete", "1", "--confirm"],
    ]) {
      expect(matchCommand(args, config).kind).toBe("not-allowed");
    }
  });

  it("refuses the commands that set up or change a login", () => {
    for (const args of [
      ["init", "--client-id", "x", "--client-secret", "y"],
      ["auth", "login"],
      ["auth", "login", "--user", "jane.doe"],
      ["auth", "logout"],
    ]) {
      expect(matchCommand(args, config).kind).toBe("not-allowed");
    }
  });

  it("refuses the template commands, reading ones included", () => {
    expect(matchCommand(["template", "list"], config).kind).toBe("not-allowed");
  });

  // Pins the exact command set, so a command added to confluence.json (a
  // writing one above all) has to be added here on purpose.
  it("allows exactly the read commands, none mutating or confirm-gated", () => {
    expect(config.allowedPrefixes).toEqual([
      { prefix: ["page", "search"], confirm: false, mutating: false },
      { prefix: ["page", "get"], confirm: false, mutating: false },
      { prefix: ["page", "children"], confirm: false, mutating: false },
      { prefix: ["page", "ancestors"], confirm: false, mutating: false },
      { prefix: ["page", "comments"], confirm: false, mutating: false },
      { prefix: ["space", "list"], confirm: false, mutating: false },
      { prefix: ["space", "get"], confirm: false, mutating: false },
      { prefix: ["doctor"], confirm: false, mutating: false },
      { prefix: ["auth", "whoami"], confirm: false, mutating: false },
    ]);
  });
});
