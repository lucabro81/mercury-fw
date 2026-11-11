/**
 * Gives a conversation its generated title (#214), once: after a turn the
 * person wrote, when the conversation has no title yet, the model names it
 * from the person's first message and the answer to it, as the archive kept
 * them (`../memory/verbatim-archive-store.ts`). The title is stored with
 * `../memory/conversation-titles-store.ts`; a title the person chose is never
 * replaced.
 *
 * Off the turn's path and fail-soft: the turn runner doesn't wait for it, and
 * a model that can't be reached leaves the conversation without a title.
 */
import { generateText, type LanguageModel } from "ai";
import { cleanGeneratedTitle, type ConversationTitle } from "../memory/conversation-titles-store.ts";
import type { TraceInput } from "../traces/tracer.ts";
import type { VerbatimMessage } from "../memory/verbatim-archive-store.ts";

/** What the model is told: a few words naming the conversation, in the person's language, and nothing else. */
export const TITLE_INSTRUCTIONS =
  "Write a short title (at most 6 words) for this conversation, in the language the user wrote in. " +
  "Reply with the title only: no quotes, no punctuation at the end.";

/** How much of the first question and of the first answer the model reads, in characters. */
export const OPENING_MAX_CHARS = 1500;

/** The slice of `generateText` the titler calls, so tests pass a fake. */
export type GenerateTextFn = (params: { model: LanguageModel; instructions?: string; prompt: string }) => Promise<{ text: string }>;

export type ConversationTitlerDeps = {
  model: LanguageModel;
  /** Defaults to the AI SDK's `generateText`. */
  generateTextFn?: GenerateTextFn;
  /** The first messages of the conversation, oldest first, as the person saw them (`listVerbatimBySession`). */
  readOpening: (userId: string, sessionKey: string) => Promise<VerbatimMessage[]>;
  titleOf: (userId: string, sessionKey: string) => Promise<ConversationTitle | undefined>;
  /** Saves a generated title. */
  setTitle: (userId: string, sessionKey: string, title: string) => Promise<void>;
  log: (msg: string) => void;
  /** Where each attempt's `title` event goes (#23): generated, exists, empty or failed. */
  emit?: (input: TraceInput) => void;
};

/** Whether `m` has words for the model to read: not an interrupted answer, not how a confirmation was resolved. */
function hasWords(m: VerbatimMessage): boolean {
  return m.content.trim() !== "" && m.interrupted !== true && m.confirmation === undefined;
}

/** What the model reads: the person's first message and the first answer with words after it, each cut; undefined without a message of the person. */
function openingPrompt(messages: VerbatimMessage[]): string | undefined {
  const first = messages.findIndex((m) => m.role === "user" && hasWords(m));
  if (first === -1) return undefined;
  const question = messages[first]!.content.trim().slice(0, OPENING_MAX_CHARS);
  const answer = messages.slice(first + 1).find((m) => m.role === "assistant" && hasWords(m));
  const parts = [`User: ${question}`];
  if (answer !== undefined) parts.push(`Assistant: ${answer.content.trim().slice(0, OPENING_MAX_CHARS)}`);
  return parts.join("\n\n");
}

/**
 * Returns the function the turn runner calls after a turn the person wrote:
 * it titles `sessionKey` of the person `userId` if it has no title yet. It
 * never throws; one generation at a time per conversation.
 */
export function createConversationTitler(deps: ConversationTitlerDeps): (sessionKey: string, userId: string) => Promise<void> {
  const generate = deps.generateTextFn ?? (generateText as unknown as GenerateTextFn);
  const inFlight = new Set<string>();
  return async (sessionKey, userId) => {
    const id = JSON.stringify([userId, sessionKey]);
    if (inFlight.has(id)) return;
    inFlight.add(id);
    const emit = (outcome: string, args?: Record<string, unknown>) =>
      deps.emit?.({ kind: "title", session: sessionKey, person: userId, outcome, ...(args === undefined ? {} : { args }) });
    try {
      if ((await deps.titleOf(userId, sessionKey)) !== undefined) return emit("exists");
      const prompt = openingPrompt(await deps.readOpening(userId, sessionKey));
      if (prompt === undefined) return emit("empty");
      const { text } = await generate({ model: deps.model, instructions: TITLE_INSTRUCTIONS, prompt });
      const title = cleanGeneratedTitle(text);
      if (title === "") return emit("empty");
      // The person may have named it while the model was answering.
      if ((await deps.titleOf(userId, sessionKey)) !== undefined) return emit("exists");
      await deps.setTitle(userId, sessionKey, title);
      emit("generated");
    } catch (err) {
      deps.log(`[titles] no title for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
      emit("failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.delete(id);
    }
  };
}
