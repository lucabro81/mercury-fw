/**
 * Thin glue that turns `createSessionHistory`'s injected `summarize`
 * dependency into a real LLM call.
 *
 * Kept separate from `history.ts` on purpose: `history.ts`'s threshold/
 * merge/replace logic is the substantial part and is fully unit-tested
 * with a fake summarizer; this file's only job is producing the prompt
 * and calling `generateText`, which isn't worth mocking deeply for one
 * line of glue.
 *
 * Used by: `src/index.ts` (wiring), which passes the result into
 * `createSessionHistory` (see `src/session/history.ts`).
 */
import { generateText, type LanguageModel } from "ai";
import type { Message } from "./history.ts";

/** What the summarizer is told: what a future turn needs from the messages it replaces, when they were said included (#293). */
export const SUMMARY_INSTRUCTIONS =
  "Summarize this conversation concisely, preserving names, ticket keys, and decisions. " +
  "Each message from the user starts with when it was written, in brackets: keep when things were said or decided, as written there.";

/**
 * Returns a function matching `createSessionHistory`'s `summarize`
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
