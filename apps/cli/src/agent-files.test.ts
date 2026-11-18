/**
 * What a coding agent reads in an app: its AGENTS.md (what the app is, where
 * things are, the CLI, what to do and not to do) and the skill for writing a
 * plugin, in the two folders assistants look in. The same files `mfw create`
 * writes and `mfw agent-files` brings to an app made before them.
 */
import { describe, expect, test } from "bun:test";
import { parseSkill } from "@mercury-fw/kit";
import { agentFiles, AGENT_FILE_PATHS } from "./agent-files.ts";

describe("agentFiles", () => {
  const files = agentFiles("my-agent");

  test("AGENTS.md and the plugin skill for Claude and for the other assistants", () => {
    expect([...files.keys()]).toEqual(["AGENTS.md", ".claude/skills/mercury-plugin/SKILL.md", ".agents/skills/mercury-plugin/SKILL.md"]);
    expect(AGENT_FILE_PATHS).toEqual([...files.keys()]);
  });

  test("the skill is one, in both folders, and parses as a skill", () => {
    const skill = files.get(".claude/skills/mercury-plugin/SKILL.md")!;
    expect(files.get(".agents/skills/mercury-plugin/SKILL.md")).toBe(skill);
    expect(parseSkill(skill).name).toBe("mercury-plugin");
  });

  test("AGENTS.md is the app's, and opens with what an agent needs first", () => {
    const agents = files.get("AGENTS.md")!;
    expect(agents).toStartWith("# my-agent\n");
    const sections = [...agents.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual(["What it is", "Where things are", "The mfw command", "Do", "Don't"]);
  });

  test("names the commands an agent uses instead of raw docker compose", () => {
    const agents = files.get("AGENTS.md")!;
    for (const command of ["bunx mfw start", "bunx mfw restart", "bunx mfw logs", "bunx mfw repl", "bunx mfw plugin create", "bunx mfw e2e", "bun run test", "bun run typecheck"]) {
      expect(agents).toContain(command);
    }
  });

  test("points the agent at the skill when it writes a plugin", () => {
    expect(files.get("AGENTS.md")).toContain("mercury-plugin");
  });

  test("leaves no placeholder", () => {
    for (const [path, content] of files) expect({ path, left: content.match(/__[A-Z]+__/g) }).toEqual({ path, left: null });
  });
});
