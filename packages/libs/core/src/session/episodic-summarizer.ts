/**
 * Thin glue turning a closed session's messages into the episodic
 * summary written to Qdrant (see `src/memory/episodic-store.ts`) — a
 * factual account of what happened, not an interpretation. Distinct from
 * `summarizer.ts` (Layer 1): that one condenses history to keep the
 * *next* turn's prompt small, preserving whatever helps continue the
 * same conversation; this one produces a standalone record of a
 * *finished* conversation, and must not infer patterns or preferences
 * (that inference is a separate, deterministic consolidation step,
 * not this LLM call's job).
 *
 * The model has no notion of "today" of its own and invented dates when it
 * wrote one (observed live: dates from the wrong year, hedged with "replace
 * with current date if applicable"). Each message from the person now says
 * when it was written (the turn's stamp, `turn-stamp.ts`, #293), so a date
 * may be copied from there, never guessed: a conversation spanning days keeps
 * when things happened. The entry's own `timestamp` field (computed by the
 * caller, `idle-session-cron.ts`) is when the session was saved.
 *
 * `generateText` is injectable, so a test can check what the model is told.
 */
import { generateText, type LanguageModel } from "ai";
import type { Message } from "./history.ts";

/** What the episodic summarizer is told: an account of what happened, never the data a tool returned (#233). */
export const EPISODIC_SUMMARY_INSTRUCTIONS =
  "Summarize what happened in this conversation as a short, factual account for future recall — what was discussed, asked, or decided. " +
  "Describe only what occurred in this session. " +
  "Record what was asked, discussed and decided, not the data a tool returned (lists, counts, statuses, values): it changes, and is read again when needed. " +
  "Do not infer patterns, habits, or preferences about the user — that is a separate process, not this one. " +
  "Each message from the user starts with when it was written, in brackets: mention a date only as written there, and never guess one.";

/** The part of `generateText` the summarizer calls. */
type GenerateFn = (params: { model: LanguageModel; instructions: string; prompt: string }) => Promise<{ text: string }>;

/** Returns a function that summarizes a closed session's messages into a factual account. */
export function createEpisodicSummarizer(
  model: LanguageModel,
  generate: GenerateFn = (params) => generateText(params),
): (messages: Message[]) => Promise<string> {
  return async (messages) => {
    const { text } = await generate({
      model,
      instructions: EPISODIC_SUMMARY_INSTRUCTIONS,
      prompt: messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
    });
    return text;
  };
}
