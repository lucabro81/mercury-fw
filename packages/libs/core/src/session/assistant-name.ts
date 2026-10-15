/**
 * The assistant's name, kept apart from the persona's identity and tone so
 * that every text the model reads refers to it instead of writing a name in.
 * Static texts (the persona, the core's prompt blocks, plugin fragments,
 * skills, tool descriptions) carry the `{{assistant}}` placeholder, which the
 * core substitutes before the model sees them; texts built while running get
 * the name itself from the runtime context.
 */
import type { Tool } from "ai";

/** What static model-facing texts write where the assistant's name goes. */
export const ASSISTANT_PLACEHOLDER = "{{assistant}}";

/** The name an instance's assistant has when its persona sets none. */
export const DEFAULT_ASSISTANT_NAME = "Mercury";

const MAX_NAME_LENGTH = 40;

/** `text` with every `{{assistant}}` replaced by `name`, inserted literally. */
export function withAssistantName(text: string, name: string): string {
  return text.replaceAll(ASSISTANT_PLACEHOLDER, () => name);
}

/**
 * The assistant's name from the persona: the default when it sets none.
 * Throws on a name that can't stand in a prompt: blank, longer than 40
 * characters, with a line break or another control character, or holding the
 * placeholder itself.
 */
export function assistantNameOf(persona: { name?: string } | undefined): string {
  if (persona?.name === undefined) return DEFAULT_ASSISTANT_NAME;
  const name = persona.name.trim();
  if (name.length === 0) throw new Error("persona.name is empty");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`persona.name is longer than ${MAX_NAME_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("persona.name has a line break or another control character");
  if (name.includes(ASSISTANT_PLACEHOLDER)) throw new Error(`persona.name holds ${ASSISTANT_PLACEHOLDER} itself`);
  return name;
}

/** `tools` with the assistant's name substituted in each description. */
export function toolsWithAssistantName(tools: Record<string, Tool>, name: string): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    out[toolName] =
      tool.description === undefined ? tool : ({ ...tool, description: withAssistantName(tool.description, name) } as Tool);
  }
  return out;
}
