/**
 * The window's `summarize` as a model call: the instructions, and the
 * messages it folds as one prompt. `history.ts` holds the logic and is
 * tested with a fake summarizer; this is only the glue to `generateText`.
 *
 * Used by: `index.ts`, on the plugin's model (`ctx.model`, the turn's: the
 * person is waiting for this).
 */
import { generateText, type LanguageModel } from "ai";
import type { Message } from "./history.ts";

/** What the summarizer is told: what a future turn needs from the messages it replaces, when they were said included (#293). */
export const SUMMARY_INSTRUCTIONS =
  "Summarize this conversation concisely, preserving names, ticket keys, and decisions. " +
  "Each message from the user starts with when it was written, in brackets: keep when things were said or decided, as written there.";

/**
 * Returns a function matching `createWindow`'s `summarize`
 * signature, backed by `model`. The returned function asks the model to
 * condense the given messages into a short summary that preserves
 * names, ticket keys, decisions and when they happened — the things a
 * future turn would otherwise lose once the raw messages are cleared.
 */
export function createSummarizer(
  model: LanguageModel,
): (messages: Message[]) => Promise<string> {
  return async (messages) => {
    const { text } = await generateText({
      model,
      instructions: SUMMARY_INSTRUCTIONS,
      prompt: messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
    });
    return text;
  };
}
