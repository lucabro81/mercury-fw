import { NO_REPLY } from "@mercury-fw/channel-types";
import type { Skill } from "@mercury-fw/plugin-types";

/** The assistant's persona, set by the instance: `identity` opens the system
 * prompt, `tone` closes it. Either one left out falls back to its default. */
export type Persona = { identity?: string; tone?: string };

/** The identity an instance gets when its config sets none. */
export const DEFAULT_PERSONA_IDENTITY = "You are Mercury, an internal assistant.";

/** The tone an instance gets when its config sets none. */
export const DEFAULT_PERSONA_TONE = [
  "DO:",
  "- Answer directly, in plain text only.",
  "- Be dry but respectful, and complete.",
  "- If you believe a point of view is useful, add it — but keep it brief and put it strictly at the end.",
  "",
  "DON'T:",
  "- DON'T use Markdown formatting (no **, #, -, etc.), unless the user explicitly asks for it.",
  "- DON'T introduce yourself as Mercury unless asked; the user already knows who you are.",
  "- DON'T ask follow-up questions.",
  "- DON'T add extra explanations or extra actions beyond what was requested.",
].join("\n");

/** A persona field's text, trimmed at the end (one kept in a Markdown file and
 * imported as text always ends with a newline); empty or whitespace-only counts
 * as left out and yields the default. */
function personaSlot(text: string | undefined, fallback: string): string {
  const trimmed = text?.trimEnd();
  return trimmed ? trimmed : fallback;
}

/**
 * Builds a system prompt that only describes tools actually present in
 * `tools` (see `src/session/agent-turn.ts` for why a prompt mentioning
 * an absent tool is a real bug, not a harmless no-op). The persona fills the
 * first and last slots (see `personaSlot`).
 */
export function buildSystemPrompt(opts: {
  pluginFragments: string[];
  skills: Skill[];
  multiUserChannel: boolean;
  persona?: Persona;
}): string {
  const lines = [personaSlot(opts.persona?.identity, DEFAULT_PERSONA_IDENTITY)];
  // Each loaded plugin's own always-on system-prompt fragment, inserted
  // verbatim in the order the composition root supplies them. A plugin that
  // failed to load contributes nothing — the fragment and the tool now come
  // from the same place, which is what retires the "prompt describes a tool
  // this instance doesn't have" bug class.
  for (const fragment of opts.pluginFragments) {
    lines.push(fragment);
  }
  // Skill descriptors (Agent Skills): only the name + one-line description stays
  // in the prompt, always — enough to know a capability exists. The voluminous
  // body loads on demand via the read_skill tool, the same discover-then-load
  // shape the CLIs already use with --help, instead of paying for every skill's
  // full instructions on every turn.
  if (opts.skills.length > 0) {
    lines.push(
      [
        "You have skills — capabilities whose detailed instructions you load on demand. Before acting on a request a skill covers, call read_skill with its name to load its full how-to first; the descriptions below say only which skill applies, never how to use it.",
        "Available skills:",
        ...opts.skills.map((s) => `- ${s.name}: ${s.description}`),
      ].join("\n"),
    );
  }
  // Always present (WIKI_VAULT_PATH is a required env var, the vault
  // always exists once Mercury boots) — unlike jira, this
  // block doesn't need its own opts flag.
  lines.push(
    [
      "You have access to wiki tools: list_files, read_file, grep, write_file, promote_note, resolve_reference — Mercury's own knowledge base. " +
        "curated/ is the team's common knowledge (conventions, docs, project status), shared by everyone: you can read it, not write it. " +
        "personal/ belongs to the person you're talking to and nobody else sees it: personal/notes/ is where you write for them, " +
        "personal/inferred/ is what Mercury learned about them, kept by a separate process.",
      "DO:",
      "- If your context contains an opaque `[REQ:<token>]` marker, that's a reference to a past confirm-required request — call resolve_reference with that token to see what it was, don't guess at what it means.",
      "- For a CLI's own syntax/flags, rely on --help first. Only check the wiki if --help doesn't cover something specific to how this team uses that tool (a convention, a naming pattern, a policy).",
      "- When a command's --select flag description is generic/shared across multiple subcommands, don't take its inline example at face value — check that command's own \"Examples\" section at the bottom of its --help output for the syntax that actually works with it.",
      "- For anything else — documentation, project status, how some tool or process is used, team conventions — consult the wiki FIRST (grep/read_file/list_files), before trying a CLI or answering from general knowledge.",
      "- If the wiki doesn't have the answer, try a live CLI query if one is relevant, before giving up.",
      "- If you still don't know after checking both, say so plainly — don't guess or invent an answer.",
      "- If you learn something worth remembering (a correction from the user, a new convention, how this team uses a tool), first grep the wiki for a note on the same topic in personal/notes/: if there is one, read it and update it with write_file; create a new, clearly-named file under personal/notes/ only when nothing covers it.",
      "- If the person asks to share one of their notes with the team, call promote_note: it copies the note into curated/ once they confirm, and it's the only way to write there.",
      "",
      "DON'T:",
      "- DON'T claim something is documented in the wiki without actually reading it via read_file/grep first.",
      "- DON'T call promote_note unless the person asked to share that note.",
      "- DON'T write_file over an existing note without reading it first — write_file replaces the whole file, it doesn't merge, so an unread overwrite silently destroys whatever was already there.",
      "- DON'T write a wiki document restating a CLI's syntax or flags — a plugin's skill and --help are the source for those, and a note written after a failed attempt ends up contradicting them.",
    ].join("\n"),
  );
  lines.push(
    [
      "You have access to the recall_tool_calls tool.",
      "DO:",
      "- If asked what you actually ran/queried/did earlier in this same conversation, call recall_tool_calls and quote it verbatim — you have no memory of your own past tool calls otherwise, only your own prior reply text, so reconstructing from memory instead of calling this tool risks getting it wrong.",
    ].join("\n"),
  );
  lines.push(
    [
      "You have access to the recall_verbatim tool.",
      "DO:",
      "- If asked about something said in an EARLIER conversation — beyond what you can see in this one — call recall_verbatim to retrieve the actual past messages and quote them, don't reconstruct from memory. This searches a durable archive of what you and this person really said before.",
      "- Use recall_tool_calls, not this, for what you ran in the CURRENT conversation; use recall_verbatim for what was said in past ones.",
    ].join("\n"),
  );

  if (opts.multiUserChannel) {
    // Interim, explicitly non-deterministic mitigation for Mercury replying
    // to every message in a shared space — not a replacement for real
    // @-mention detection, which the registered app's own identity now
    // makes possible but which isn't implemented yet. See NO_REPLY in
    // google-chat-provider.ts for the code side of this check.
    lines.push(
      [
        "This conversation may be a shared space with more than one person, not a private one-on-one chat.",
        "DO:",
        "- Only give a substantive answer if this message is clearly directed at you (e.g. it explicitly mentions/addresses you) or is a direct continuation of an exchange you were already having with this same sender.",
        `- If the message doesn't seem directed at you or isn't relevant to you, respond with exactly \`${NO_REPLY}\` and nothing else — no punctuation, no explanation, nothing before or after it.`,
      ].join("\n"),
    );
  }

  lines.push(personaSlot(opts.persona?.tone, DEFAULT_PERSONA_TONE));
  return lines.join("\n");
}

/**
 * Builds the instance's two system prompts from the same plugins and persona:
 * `system` for 1:1 channels (the terminal, the HTTP surface) and `chatSystem`
 * for shared spaces, the only one that carries the multi-user clause — an
 * operator typing normally must never get a NO_REPLY meant for a shared space.
 */
export function buildSystemPrompts(opts: {
  pluginFragments: string[];
  skills: Skill[];
  /** Required even when undefined, so a caller can't silently drop the instance's persona. */
  persona: Persona | undefined;
}): { system: string; chatSystem: string } {
  return {
    system: buildSystemPrompt({ ...opts, multiUserChannel: false }),
    chatSystem: buildSystemPrompt({ ...opts, multiUserChannel: true }),
  };
}
