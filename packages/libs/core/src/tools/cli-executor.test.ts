import { describe, it, expect } from "bun:test";
import { runCli } from "@mercury-fw/cli-engine";

describe("runCli", () => {
  it("parses valid JSON stdout on exit code 0", async () => {
    const result = await runCli("bun", [
      "-e",
      "console.log(JSON.stringify({ hello: 'world' }))",
    ]);
    expect(result).toEqual({ ok: true, data: { hello: "world" } });
  });

  it("returns a structured error on non-zero exit, never throws", async () => {
    const result = await runCli("bun", [
      "-e",
      "console.error('boom'); process.exit(2)",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("boom");
      expect(result.error).toContain("2");
    }
  });

  // Regression: exit 0 with non-JSON stdout was reported as a tool
  // failure ({ ok: false, error: "failed to parse JSON..." }). `jira
  // --help`/`jira issue --help` are exactly this shape — plain text, exit
  // 0 — so the model saw three "failed" tool calls before its first real
  // success on every session that started with discovery via --help,
  // observed live to send it into a confused, apologetic retry spiral.
  // Exit 0 is success regardless of whether stdout happens to be JSON;
  // non-JSON stdout is just plain-text data, not a parse error.
  // #176: exit code 3 means the identity has to log in, which the caller
  // tells apart from any other failure only by the code itself.
  it("carries the exit code on a non-zero exit", async () => {
    const result = await runCli("bun", ["-e", "console.error('not logged in'); process.exit(3)"]);
    expect(result).toEqual({ ok: false, error: "bun exited with code 3: not logged in", exitCode: 3 });
  });

  it("returns the raw text as data when stdout is not valid JSON but exit code is 0", async () => {
    const result = await runCli("bun", ["-e", "console.log('not json')"]);
    expect(result).toEqual({ ok: true, data: "not json" });
  });

  it("returns an empty string as data when stdout is empty and exit code is 0", async () => {
    const result = await runCli("bun", ["-e", "1"]);
    expect(result).toEqual({ ok: true, data: "" });
  });

  it("returns a structured error when the binary does not exist on PATH, never crashes", async () => {
    const result = await runCli("this-binary-does-not-exist-xyz", []);
    expect(result.ok).toBe(false);
  });
});
