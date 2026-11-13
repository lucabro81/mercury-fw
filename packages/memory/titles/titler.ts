/**
 * Gives a conversation its generated title (#214), once: after a turn the
 * person wrote, when the conversation has no title yet, the model names it
 * from what the person wrote and the answer they got. A title the person
 * chose is never replaced.
 *
 * Fail-soft: a model that can't be reached leaves the conversation without a
 * title, logged, and the next turn tries again.
 */
import { generateText, type LanguageModel } from "ai";
import { cleanGeneratedTitle } from "./clean-title.ts";

/** What the model is told: a few words naming the conversation, in the person's language, and nothing else. */
export const TITLE_INSTRUCTIONS =
  "Write a short title (at most 6 words) for this conversation, in the language the user wrote in. " +
  "Reply with the title only: no quotes, no punctuation at the end.";

/** How much of the question and of the answer the model reads, in characters. */
export const OPENING_MAX_CHARS = 1500;

/** The slice of `generateText` the titler calls, so tests pass a fake. */
export type GenerateTextFn = (params: { model: LanguageModel; instructions?: string; prompt: string }) => Promise<{ text: string }>;

export type ConversationTitlerDeps = {
  model: LanguageModel;
  /** Defaults to the AI SDK's `generateText`. */
  generateTextFn?: GenerateTextFn;
  /** Whether the person's conversation has a title already, theirs or a generated one. */
  hasTitle: (userId: string, sessionKey: string) => Promise<boolean>;
  /** Saves a generated title. */
  setTitle: (userId: string, sessionKey: string, title: string) => Promise<void>;
  log: (msg: string) => void;
};

/** A turn the person wrote, as the titler reads it. */
export type TitledTurn = { sessionKey: string; userId: string; question: string; answer: string };

/** What the model reads: the question and the answer, when it has words, each cut. */
function openingPrompt(turn: TitledTurn): string {
  const parts = [`User: ${turn.question.trim().slice(0, OPENING_MAX_CHARS)}`];
  if (turn.answer.trim() !== "") parts.push(`Assistant: ${turn.answer.trim().slice(0, OPENING_MAX_CHARS)}`);
  return parts.join("\n\n");
}

/**
 * Returns the function called after a turn the person wrote: it titles the
 * turn's conversation if it has no title yet. It never throws; one
 * generation at a time per conversation.
 */
export function createConversationTitler(deps: ConversationTitlerDeps): (turn: TitledTurn) => Promise<void> {
  const generate = deps.generateTextFn ?? (generateText as unknown as GenerateTextFn);
  const inFlight = new Set<string>();
  return async (turn) => {
    const { userId, sessionKey } = turn;
    if (turn.question.trim() === "") return;
    const id = JSON.stringify([userId, sessionKey]);
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      if (await deps.hasTitle(userId, sessionKey)) return;
      const { text } = await generate({ model: deps.model, instructions: TITLE_INSTRUCTIONS, prompt: openingPrompt(turn) });
      const title = cleanGeneratedTitle(text);
      if (title === "") return;
      // The person may have named it while the model was answering.
      if (await deps.hasTitle(userId, sessionKey)) return;
      await deps.setTitle(userId, sessionKey, title);
    } catch (err) {
      deps.log(`[titles] no title for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight.delete(id);
    }
  };
}
