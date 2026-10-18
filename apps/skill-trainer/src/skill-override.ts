/**
 * Puts a candidate skill in a plugin: the body is what's trained, the name and
 * description stay the plugin's own, since the description decides whether
 * the model loads the skill at all and changing it is another experiment.
 */
import { parseSkill, type Plugin } from "@mercury-fw/plugin-types";

/** The body in `candidate`: the text itself, or the body of a whole `SKILL.md`
 * whose frontmatter must be the skill's own. */
function bodyOf(candidate: string, skill: { name: string; description: string }): string {
  if (!candidate.startsWith("---\n")) return candidate;
  const parsed = parseSkill(candidate);
  if (parsed.name !== skill.name) throw new Error(`the candidate is the "${parsed.name}" skill, not "${skill.name}"`);
  if (parsed.description !== skill.description) throw new Error(`the candidate's description differs from the ${skill.name} skill's`);
  return parsed.body;
}

/** `plugin` with its `skillName` skill's body replaced by `candidate`'s; the
 * plugin itself unchanged when `candidate` is undefined. Throws when the
 * plugin has no such skill. Never changes the plugin it's given. */
export function withSkill(plugin: Plugin, skillName: string, candidate: string | undefined): Plugin {
  const skills = plugin.skills ?? [];
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) {
    throw new Error(`the ${plugin.name} plugin has no "${skillName}" skill (it has: ${skills.map((s) => s.name).join(", ") || "none"})`);
  }
  if (candidate === undefined) return plugin;
  const body = bodyOf(candidate, skill);
  return { ...plugin, skills: skills.map((s) => (s === skill ? { ...s, body } : s)) };
}
