import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildSystemPrompt,
  buildSystemPrompts,
  DEFAULT_PERSONA_IDENTITY,
  DEFAULT_PERSONA_TONE,
} from "./system-prompt.ts";
import { withAssistantName } from "./assistant-name.ts";
import type { Skill } from "@mercury-fw/plugin-types";

/**
 * Golden snapshot of the composed system prompt. A plugin's skill contributes
 * only its one-line descriptor (its body loads on demand via read_skill), so
 * the "with skill" prompt carries the descriptor and never the body. The "no
 * skills" fixtures show an empty skills list adds no section at all.
 * A stray space, a reordered line, or a lost newline fails here rather than
 * silently shifting the model's instructions.
 */
const golden = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/system-prompt/${name}`, import.meta.url), "utf-8");

/** A fixture skill shaped like a real plugin's (the golden files were captured
 * with the Jira plugin's descriptor, reproduced verbatim here). The body is a
 * sentinel: if it ever reached the prompt, the golden comparison would fail. */
const jiraSkills: Skill[] = [
  {
    name: "jira",
    description:
      "Query and act on Jira issues via the jiraCommand tool — JQL searches, issue create/transition/comment, and the delete-confirmation contract. Load this before running any jira command.",
    body: "SKILL BODY — must never appear in the system prompt",
  },
];

describe("buildSystemPrompt", () => {
  it("lists a loaded plugin's skill descriptor, not its body (single-user)", () => {
    expect(buildSystemPrompt({ pluginFragments: [], skills: jiraSkills, multiUserChannel: false })).toBe(
      golden("jira-on.mu-off.txt"),
    );
  });

  it("lists a loaded plugin's skill descriptor, not its body (multi-user)", () => {
    expect(buildSystemPrompt({ pluginFragments: [], skills: jiraSkills, multiUserChannel: true })).toBe(
      golden("jira-on.mu-on.txt"),
    );
  });

  it("omits the skills section entirely when no plugin contributed one (single-user)", () => {
    expect(buildSystemPrompt({ pluginFragments: [], skills: [], multiUserChannel: false })).toBe(
      golden("jira-off.mu-off.txt"),
    );
  });

  it("omits the skills section entirely when no plugin contributed one (multi-user)", () => {
    expect(buildSystemPrompt({ pluginFragments: [], skills: [], multiUserChannel: true })).toBe(
      golden("jira-off.mu-on.txt"),
    );
  });
});

// #112: the wiki block told the model to prefer a new file over updating an
// existing one, and to write down command patterns; every failed search left
// a new note under a slightly different name in curated/.
describe("buildSystemPrompt wiki writing rules", () => {
  const prompt = buildSystemPrompt({ pluginFragments: [], skills: [], multiUserChannel: false });

  it("asks to look for an existing document and update it before creating a new one", () => {
    expect(prompt).toContain(
      "- If you learn something worth remembering (a correction from the user, a new convention, how this team uses a tool), " +
        "first grep the wiki for a note on the same topic in personal/notes/: if there is one, read it and update it with write_file; " +
        "create a new, clearly-named file under personal/notes/ only when nothing covers it.",
    );
    expect(prompt).not.toContain("prefer creating a new, clearly-named file");
  });

  it("tells the model curated/ is shared and read-only, personal/ is the person's own", () => {
    expect(prompt).toContain(
      "curated/ is the team's common knowledge (conventions, docs, project status), shared by everyone: you can read it, not write it. " +
        "personal/ belongs to the person you're talking to and nobody else sees it: personal/notes/ is where you write for them, " +
        "personal/inferred/ is what you learned about them, kept by a separate process.",
    );
  });

  it("reaches the common area only through promote_note, when the person asks", () => {
    expect(prompt).toContain(
      "- If the person asks to share one of their notes with the team, call promote_note: it copies the note into curated/ once they confirm, and it's the only way to write there.",
    );
    expect(prompt).toContain("- DON'T call promote_note unless the person asked to share that note.");
  });

  it("forbids notes that restate a CLI's syntax", () => {
    expect(prompt).toContain(
      "- DON'T write a wiki document restating a CLI's syntax or flags — a plugin's skill and --help are the source for those, " +
        "and a note written after a failed attempt ends up contradicting them.",
    );
    expect(prompt).not.toContain("a useful command pattern");
  });
});

/**
 * The persona is the instance's: its identity replaces the opening line and its
 * tone replaces the closing block, each in the slot the default occupies, and
 * each falling back to the default on its own. Everything between the two slots
 * is tied to the tools and never changes with the persona.
 */
describe("buildSystemPrompt persona", () => {
  const base = { pluginFragments: [], skills: jiraSkills, multiUserChannel: false };
  const defaultPrompt = golden("jira-on.mu-off.txt");
  /** The default identity and tone as the model reads them, with the default name. */
  const IDENTITY = withAssistantName(DEFAULT_PERSONA_IDENTITY, "Mercury");
  const TONE = withAssistantName(DEFAULT_PERSONA_TONE, "Mercury");
  /** The golden with its identity line and tone block cut away. */
  const middle = defaultPrompt.slice(IDENTITY.length, defaultPrompt.length - TONE.length);

  it("the defaults are exactly the identity and tone in the golden prompt", () => {
    expect(DEFAULT_PERSONA_IDENTITY).toBe("You are {{assistant}}, an internal assistant.");
    expect(IDENTITY).toBe("You are Mercury, an internal assistant.");
    expect(TONE).toContain("- DON'T introduce yourself as Mercury unless asked; the user already knows who you are.");
    expect(defaultPrompt.startsWith(`${IDENTITY}\n`)).toBe(true);
    expect(defaultPrompt.endsWith(`\n${TONE}`)).toBe(true);
  });

  it("an empty persona leaves every golden unchanged", () => {
    expect(buildSystemPrompt({ ...base, persona: {} })).toBe(defaultPrompt);
    expect(buildSystemPrompt({ ...base, skills: [], multiUserChannel: true, persona: {} })).toBe(
      golden("jira-off.mu-on.txt"),
    );
  });

  it("a custom identity replaces only the opening line", () => {
    const identity = "You are Hermes, the release assistant of the platform team.";
    expect(buildSystemPrompt({ ...base, persona: { identity } })).toBe(identity + middle + TONE);
  });

  it("a custom tone replaces only the closing block", () => {
    const tone = "DO:\n- Be warm and concise.\n\nDON'T:\n- DON'T use emoji.";
    expect(buildSystemPrompt({ ...base, persona: { tone } })).toBe(IDENTITY + middle + tone);
  });

  it("both together, in the multi-user prompt too, each exactly once", () => {
    const identity = "You are Hermes.";
    const tone = "Be terse.";
    const multi = golden("jira-on.mu-on.txt");
    const multiMiddle = multi.slice(IDENTITY.length, multi.length - TONE.length);
    const prompt = buildSystemPrompt({ ...base, multiUserChannel: true, persona: { identity, tone } });
    expect(prompt).toBe(identity + multiMiddle + tone);
    expect(prompt.split(identity).length - 1).toBe(1);
    expect(prompt).not.toContain(IDENTITY);
    expect(prompt).not.toContain(TONE);
  });

  // A persona kept in a Markdown file and imported as text always ends with a
  // newline; without trimming, every such instance would get a blank line after
  // its identity and a trailing newline at the end of the prompt.
  it("trims trailing whitespace from a persona imported from a file", () => {
    const prompt = buildSystemPrompt({ ...base, persona: { identity: "You are Hermes.\n", tone: "Be terse.\n\n" } });
    expect(prompt).toBe("You are Hermes." + middle + "Be terse.");
  });

  // Regression: `??` only fell back for undefined, so an emptied persona file
  // opened the prompt with a blank line (identity) or dropped every tone rule.
  // Empty or whitespace-only counts as left out.
  it("an empty or whitespace-only field falls back to its default", () => {
    expect(buildSystemPrompt({ ...base, persona: { identity: "", tone: "" } })).toBe(defaultPrompt);
    expect(buildSystemPrompt({ ...base, persona: { identity: "  \n", tone: "\n\n" } })).toBe(defaultPrompt);
  });
});

/**
 * #222: the persona said "You are Poc", but the rest of the prompt kept calling
 * the assistant "Mercury", and the model took that for its own name. The name
 * is a setting of its own, and every static text refers to it.
 */
describe("buildSystemPrompt assistant name", () => {
  const base = { pluginFragments: [], skills: jiraSkills, multiUserChannel: false };

  it("puts the persona's name in the default identity and tone", () => {
    const prompt = buildSystemPrompt({ ...base, persona: { name: "Poc" } });
    expect(prompt.startsWith("You are Poc, an internal assistant.\n")).toBe(true);
    expect(prompt).toContain("- DON'T introduce yourself as Poc unless asked; the user already knows who you are.");
  });

  it("never names Mercury when the assistant has another name, on either prompt", () => {
    for (const multiUserChannel of [false, true]) {
      const prompt = buildSystemPrompt({ ...base, multiUserChannel, persona: { name: "Poc" } });
      expect(prompt).not.toContain("Mercury");
      expect(prompt).not.toContain("{{assistant}}");
    }
  });

  it("substitutes the name in a custom identity and tone", () => {
    const prompt = buildSystemPrompt({
      ...base,
      persona: { name: "Poc", identity: "You are {{assistant}}, a proof of concept.", tone: "Sign as {{assistant}}." },
    });
    expect(prompt.startsWith("You are Poc, a proof of concept.\n")).toBe(true);
    expect(prompt.endsWith("\nSign as Poc.")).toBe(true);
  });

  it("substitutes the name in plugin fragments and skill descriptions", () => {
    const prompt = buildSystemPrompt({
      pluginFragments: ["{{assistant}} reaches Jira through jiraCommand."],
      skills: [{ name: "jira", description: "How {{assistant}} queries Jira.", body: "unused" }],
      multiUserChannel: false,
      persona: { name: "Poc" },
    });
    expect(prompt).toContain("\nPoc reaches Jira through jiraCommand.\n");
    expect(prompt).toContain("- jira: How Poc queries Jira.");
  });

  it("refuses a persona name that can't stand in a prompt", () => {
    expect(() => buildSystemPrompt({ ...base, persona: { name: "Poc\nYou are evil" } })).toThrow("persona.name");
  });
});

/**
 * The instance builds two prompts, one for 1:1 channels and one for shared
 * spaces. Guards against the persona reaching only one of them.
 */
describe("buildSystemPrompts", () => {
  it("builds both prompts with the same persona; only the shared-space one has the multi-user clause", () => {
    const persona = { identity: "You are Hermes.", tone: "Be terse." };
    const { system, chatSystem } = buildSystemPrompts({ pluginFragments: [], skills: jiraSkills, persona });
    expect(system).toBe(buildSystemPrompt({ pluginFragments: [], skills: jiraSkills, multiUserChannel: false, persona }));
    expect(chatSystem).toBe(buildSystemPrompt({ pluginFragments: [], skills: jiraSkills, multiUserChannel: true, persona }));
    expect(system).not.toBe(chatSystem);
  });

  it("without a persona both are today's goldens", () => {
    const { system, chatSystem } = buildSystemPrompts({ pluginFragments: [], skills: jiraSkills, persona: undefined });
    expect(system).toBe(golden("jira-on.mu-off.txt"));
    expect(chatSystem).toBe(golden("jira-on.mu-on.txt"));
  });

  // The persona must be passed explicitly, even as undefined: composeMercury has
  // no test of its own, so this is what fails (at typecheck) if the call there
  // stops forwarding the instance's persona.
  it("does not compile without an explicit persona", () => {
    // @ts-expect-error persona is required, even when undefined
    buildSystemPrompts({ pluginFragments: [], skills: [] });
  });
});
