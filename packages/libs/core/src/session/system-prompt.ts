import { NO_REPLY } from "@mercury-fw/channel-types";
import type { Skill } from "@mercury-fw/plugin-types";
import { assistantNameOf, withAssistantName } from "./assistant-name.ts";

/** The assistant's persona, set by the instance: `name` is what every text
 * calls the assistant (`{{assistant}}` in them, see `assistant-name.ts`),
 * `identity` opens the system prompt, `tone` closes it. Each one left out
 * falls back to its default. */
export type Persona = { name?: string; identity?: string; tone?: string };

/** The identity an instance gets when its config sets none. */
export const DEFAULT_PERSONA_IDENTITY = "You are {{assistant}}, an internal assistant.";

/** What the stamp on each message is (`turn-stamp.ts`, #293): its shape, never an example date, which a small model would take for today. */
export const TURN_STAMP_NOTE =
  "Each message from a user starts with when and where they wrote it, in brackets: [weekday YYYY-MM-DD HH:MM time zone]. " +
  "That is the current date and their local time: use it for anything that depends on the date or the time. Never repeat that line in your answers.";

/** The tone an instance gets when its config sets none. */
export const DEFAULT_PERSONA_TONE = [
  "DO:",
  "- Answer directly, in plain text only.",
  "- Be dry but respectful, and complete.",
  "- If you believe a point of view is useful, add it — but keep it brief and put it strictly at the end.",
  "",
  "DON'T:",
  "- DON'T use Markdown formatting (no **, #, -, etc.), unless the user explicitly asks for it.",
  "- DON'T introduce yourself as {{assistant}} unless asked; the user already knows who you are.",
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
 * first and last slots (see `personaSlot`), and its name replaces the
 * placeholder everywhere, the plugins' descriptions, fragments and skills
 * included. Throws on a persona name that can't stand in a prompt.
 */
export function buildSystemPrompt(opts: {
  pluginFragments: string[];
  /** The plugins offered to the person, with what each lets the assistant do. */
  plugins: Array<{ name: string; description: string }>;
  skills: Skill[];
  multiUserChannel: boolean;
  persona?: Persona;
  /** Whether the session has `recall_verbatim` (it needs a vector index); described when left out. */
  recallVerbatim?: boolean;
}): string {
  const assistantName = assistantNameOf(opts.persona);
  // Right after the identity: what the line on every message is, whatever the plugins.
  const lines = [personaSlot(opts.persona?.identity, DEFAULT_PERSONA_IDENTITY), TURN_STAMP_NOTE];
  // What the assistant can do, one line per plugin offered: the list it
  // answers "what can you do?" from. How to use each one is the business of
  // its fragment and skills, below.
  if (opts.plugins.length > 0) {
    lines.push(
      [
        "Your plugins, and what each one lets you do:",
        ...opts.plugins.map((p) => `- ${p.name}: ${p.description}`),
        "When asked what you can do, answer from this list: say what each plugin lets you do, not the tools behind it.",
      ].join("\n"),
    );
  }
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
  // Always present: every confirm-required action leaves a note, and the
  // primer points at the ones still open (see data/confirmation-notes.ts).
  lines.push(
    [
      "You have access to the resolve_reference tool.",
      "DO:",
      "- If your context contains an opaque `[REQ:<token>]` marker, that's a reference to a past confirm-required request — call resolve_reference with that token to see what it was, don't guess at what it means.",
    ].join("\n"),
  );
  lines.push(
    [
      "You have access to the set_preferred_name tool.",
      "DO:",
      "- When the person tells you how they want to be called, now or in any later conversation, save it with set_preferred_name.",
    ].join("\n"),
  );
  if (opts.recallVerbatim !== false) lines.push(
    [
      "You have access to the recall_verbatim tool.",
      "DO:",
      "- If asked about something said in an EARLIER conversation — beyond what you can see in this one — call recall_verbatim to retrieve the actual past messages and quote them, don't reconstruct from memory. This searches a durable archive of what you and this person really said before.",
      "- Use it only for what was said in past conversations, never for what you ran in the CURRENT one.",
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
  return withAssistantName(lines.join("\n"), assistantName);
}

/**
 * Builds the instance's two system prompts from the same plugins and persona:
 * `system` for 1:1 channels (the terminal, the HTTP surface) and `chatSystem`
 * for shared spaces, the only one that carries the multi-user clause — an
 * operator typing normally must never get a NO_REPLY meant for a shared space.
 */
export function buildSystemPrompts(opts: {
  pluginFragments: string[];
  plugins: Array<{ name: string; description: string }>;
  skills: Skill[];
  /** Required even when undefined, so a caller can't silently drop the instance's persona. */
  persona: Persona | undefined;
  recallVerbatim?: boolean;
}): { system: string; chatSystem: string } {
  return {
    system: buildSystemPrompt({ ...opts, multiUserChannel: false }),
    chatSystem: buildSystemPrompt({ ...opts, multiUserChannel: true }),
  };
}
