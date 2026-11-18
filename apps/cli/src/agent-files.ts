/**
 * What a coding agent reads in an app: `AGENTS.md` (what the app is, where
 * things are, the `mfw` command, what to do and not to do) and the skill for
 * writing a plugin, `mercury-plugin`, in `.claude/skills/` and
 * `.agents/skills/`, the folders assistants look in. `mfw create` writes
 * them into a new app, `mfw agent-files` into one made before them.
 */
import agentsMd from "../template/AGENTS.md.tpl" with { type: "text" };
import pluginSkill from "../template/skills/mercury-plugin/SKILL.md.tpl" with { type: "text" };

/** Where the files go in the app, in the order they're written. */
export const AGENT_FILE_PATHS = ["AGENTS.md", ".claude/skills/mercury-plugin/SKILL.md", ".agents/skills/mercury-plugin/SKILL.md"];

/** The files for the app called `appName`, by path. */
export function agentFiles(appName: string): Map<string, string> {
  return new Map([
    // A function, so a `$` in the name is written as it is, not read as a replacement pattern.
    ["AGENTS.md", agentsMd.replaceAll("__APP__", () => appName)],
    [".claude/skills/mercury-plugin/SKILL.md", pluginSkill],
    [".agents/skills/mercury-plugin/SKILL.md", pluginSkill],
  ]);
}
