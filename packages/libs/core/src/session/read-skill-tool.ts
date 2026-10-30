/**
 * Model-invocable loader for a plugin's Agent Skill body — the "load" half of
 * the discover-then-load shape SKILL.md introduces. The system prompt carries
 * only each skill's name and one-line description (see `buildSystemPrompt`);
 * when a request matches one, the model calls this to pull the skill's full
 * instructions into context, exactly as it calls a CLI's `--help` rather than
 * carrying every flag in the prompt. Same `tool()`-wrapping split as
 * `tool-log-recall-tool.ts` and `wiki-tools.ts`.
 *
 * Registered by the composition root only when at least one skill loaded, so an
 * instance with no skills never exposes an empty tool.
 */
import { tool } from "ai";
import { z } from "zod";
import type { Skill, ExecutableTool } from "@mercury-fw/plugin-types";

/** The tool's name, as the model calls it and as the history records it (`call-record.ts`). */
export const READ_SKILL_TOOL = "read_skill";

export function createReadSkillTool(skills: Skill[]): { [READ_SKILL_TOOL]: ExecutableTool } {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const names = skills.map((s) => s.name).join(", ");
  const read_skill = tool({
    description:
      "Load the full instructions for one of your skills by name. Each skill's name and one-line description " +
      "is listed in your system prompt; call this to get its detailed how-to (conventions, flags, examples) " +
      `BEFORE acting on a request it covers — the description alone is not enough. Available skills: ${names || "(none)"}.`,
    inputSchema: z.object({
      name: z.string().describe("The exact skill name from the 'Available skills' list in the system prompt."),
    }),
    execute: async ({ name }) => {
      const skill = byName.get(name);
      if (!skill) {
        return { ok: false as const, error: `no skill named "${name}". Available skills: ${names || "(none)"}.` };
      }
      return { ok: true as const, data: skill.body };
    },
  });

  return { [READ_SKILL_TOOL]: read_skill };
}
