/**
 * `mfw agent-files`: brings AGENTS.md and the mercury-plugin skill to an app
 * made before `mfw create` wrote them, never overwriting a file already there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFiles } from "../agent-files.ts";
import { appCommands, type AppDeps } from "./commands.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mfw-agent-files-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Deps printing into `printed`; nothing is run. */
function fake() {
  const printed: string[] = [];
  const deps: AppDeps = { run: async () => 0, capture: async () => "", ask: async () => "", print: (l) => void printed.push(l), home: "/nonexistent" };
  return { deps, printed };
}

describe("agentFiles command", () => {
  test("writes every file an app made before them lacks", async () => {
    const f = fake();
    expect(await appCommands({ dir, name: "my-agent" }, f.deps).agentFiles()).toBe(0);
    for (const [path, content] of agentFiles("my-agent")) expect(readFileSync(join(dir, path), "utf-8")).toBe(content);
    expect(f.printed).toEqual([
      "Wrote AGENTS.md",
      "Wrote .claude/skills/mercury-plugin/SKILL.md",
      "Wrote .agents/skills/mercury-plugin/SKILL.md",
    ]);
  });

  test("leaves a file already there as it is, and says so", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# ours\n");
    mkdirSync(join(dir, ".claude/skills/mercury-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/mercury-plugin/SKILL.md"), "ours\n");
    const f = fake();
    await appCommands({ dir, name: "my-agent" }, f.deps).agentFiles();
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe("# ours\n");
    expect(readFileSync(join(dir, ".claude/skills/mercury-plugin/SKILL.md"), "utf-8")).toBe("ours\n");
    expect(f.printed).toEqual([
      "Kept AGENTS.md, already there",
      "Kept .claude/skills/mercury-plugin/SKILL.md, already there",
      "Wrote .agents/skills/mercury-plugin/SKILL.md",
    ]);
  });
});
