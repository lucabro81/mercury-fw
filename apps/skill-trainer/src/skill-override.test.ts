import { describe, expect, test } from "bun:test";
import { PLUGIN_API_VERSION, type Plugin } from "@mercury-fw/plugin-types";
import { withSkill } from "./skill-override.ts";

const jira = { name: "jira", description: "Query and act on Jira issues.", body: "original jira body\n" };
const other = { name: "jql", description: "Write JQL.", body: "jql body\n" };

function plugin(): Plugin {
  return { apiVersion: PLUGIN_API_VERSION, name: "jira", actsAs: "person", skills: [jira, other], build: () => ({}) } as unknown as Plugin;
}

describe("withSkill", () => {
  test("replaces the named skill's body with a candidate body, keeping its name and description", () => {
    const result = withSkill(plugin(), "jira", "candidate body\n");
    expect(result.skills).toEqual([{ name: "jira", description: "Query and act on Jira issues.", body: "candidate body\n" }, other]);
  });

  test("takes the body of a whole SKILL.md whose frontmatter is the skill's own, parsed as the plugin parses its own", () => {
    const file = "---\nname: jira\ndescription: Query and act on Jira issues.\n---\n\ncandidate body\n";
    expect(withSkill(plugin(), "jira", file).skills?.[0]).toEqual({ ...jira, body: "candidate body" });
  });

  // Guards the fixed description against a hand-edited candidate saved with
  // Windows line endings, which a "---\n" check took for a bare body.
  test("reads a SKILL.md with CRLF line endings as a SKILL.md", () => {
    const file = "---\r\nname: jira\r\ndescription: Something else.\r\n---\r\nbody\r\n";
    expect(() => withSkill(plugin(), "jira", file)).toThrow("the candidate's description differs");
    const own = "---\r\nname: jira\r\ndescription: Query and act on Jira issues.\r\n---\r\nline one\r\nline two\r\n";
    expect(withSkill(plugin(), "jira", own).skills?.[0]?.body).toBe("line one\nline two");
  });

  test("refuses a SKILL.md with another description: the description isn't trained", () => {
    const file = "---\nname: jira\ndescription: Something else.\n---\nbody\n";
    expect(() => withSkill(plugin(), "jira", file)).toThrow("the candidate's description differs from the jira skill's");
  });

  test("refuses a SKILL.md naming another skill", () => {
    const file = "---\nname: jql\ndescription: Query and act on Jira issues.\n---\nbody\n";
    expect(() => withSkill(plugin(), "jira", file)).toThrow('the candidate is the "jql" skill, not "jira"');
  });

  test("leaves the plugin it's given as it was", () => {
    const original = plugin();
    withSkill(original, "jira", "candidate body\n");
    expect(original.skills).toEqual([jira, other]);
  });

  test("keeps everything else of the plugin", () => {
    const original = plugin();
    const result = withSkill(original, "jira", "x");
    expect(result.name).toBe("jira");
    expect(result.build).toBe(original.build);
  });

  test("without a candidate, the plugin keeps its own skill", () => {
    expect(withSkill(plugin(), "jira", undefined).skills).toEqual([jira, other]);
  });

  test("a skill the plugin doesn't have is an error naming the ones it has", () => {
    expect(() => withSkill(plugin(), "bitbucket", "x")).toThrow('the jira plugin has no "bitbucket" skill (it has: jira, jql)');
  });

  test("a skill the plugin doesn't have is an error even without a candidate", () => {
    expect(() => withSkill(plugin(), "bitbucket", undefined)).toThrow('no "bitbucket" skill');
  });
});
