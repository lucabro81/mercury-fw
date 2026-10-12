/**
 * Picking a conversation up again (#163): a channel where one person keeps
 * many conversations and reopens them whenever they want (HTTP) never ends
 * one, but the in-memory history is only a cache the idle sweep frees. When
 * the conversation comes back, this rebuilds what the model sees the way a
 * compaction would: the summary of its older part (the episodic summaries
 * of this conversation) plus its newest messages, verbatim, within a budget.
 *
 * Reads are injected (the verbatim archive and the episodic store in
 * production), and everything here fails soft: this is enrichment, and a
 * conversation that can't be rebuilt starts as it always did.
 */
import { MAX_HISTORY_CHARS, type ResumedConversation, type Message } from "./history.ts";
import type { VerbatimTail } from "../memory/verbatim-archive-store.ts";

/** What resuming reads, and where it says what it did. */
export type ResumeDeps = {
  /** The conversation's newest messages within `maxChars` (`listVerbatimTail`). */
  readTail: (query: { userId: string; sessionKey: string; maxChars: number }) => Promise<VerbatimTail>;
  /** The conversation's episodic summaries, oldest first (`getEpisodicSummariesBySession`). */
  readSummaries: (query: { userId: string; sessionKey: string }) => Promise<Array<{ summary: string }>>;
  log: (message: string) => void;
};

/** How much of a resumed conversation comes back by default: half of what the history holds before compressing, so a few turns fit before the first compression. */
export const DEFAULT_RESUME_MAX_CHARS = MAX_HISTORY_CHARS / 2;

/** `SESSION_RESUME_MAX_CHARS`: unset or empty is the default, otherwise a whole number from 0 up (0 turns resuming off); throws on anything else. */
export function parseResumeMaxChars(text: string | undefined): number {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return DEFAULT_RESUME_MAX_CHARS;
  if (!/^\d+$/.test(trimmed)) throw new Error(`SESSION_RESUME_MAX_CHARS must be a whole number from 0 up, got "${trimmed}"`);
  return Number(trimmed);
}

/**
 * The budget for resuming a turn's conversation: 0 when the channel didn't
 * mark it as one its client reopens; otherwise the channel's own, or else
 * the instance's (`instanceMaxChars`).
 */
export function resumeBudget(resume: { maxChars?: number } | undefined, instanceMaxChars: number): number {
  if (resume === undefined) return 0;
  return resume.maxChars ?? instanceMaxChars;
}

/** How much of the budget the summary of the older part may take at most. */
const SUMMARY_SHARE = 4;

const SUMMARY_SEPARATOR = "\n\n";

/**
 * The conversation `sessionKey` of the person `userId`, rebuilt within
 * `maxChars`, or undefined when there's nothing to resume (a budget of 0 or
 * less, nothing archived, or an archive that can't be read). A tail that
 * reaches the conversation's start comes back alone; otherwise the newest
 * summaries that fit a quarter of the budget lead it, and the tail keeps the
 * rest, still opening with what the person said.
 */
export async function resumeConversation(
  query: { userId: string; sessionKey: string; maxChars: number },
  deps: ResumeDeps,
): Promise<ResumedConversation | undefined> {
  if (query.maxChars <= 0) return undefined;
  let tail: VerbatimTail;
  try {
    tail = await deps.readTail(query);
  } catch (err) {
    deps.log(`[memory] couldn't resume ${query.sessionKey}, it starts without its earlier messages: ${String(err)}`);
    return undefined;
  }

  let summary: string | undefined;
  let messages = tail.messages;
  if (!tail.complete) {
    summary = await olderPart(query, deps);
    if (summary !== undefined) messages = trimToFit(messages, query.maxChars - summary.length);
  }
  if (messages.length === 0 && summary === undefined) return undefined;

  deps.log(`[memory] resumed ${query.sessionKey}: ${messages.length} messages, ${summary === undefined ? "no summary" : "summary"}`);
  return summary === undefined ? { messages } : { summary, messages };
}

/** The newest episodic summaries of the conversation that fit a quarter of the budget, joined oldest first; undefined when none fits or they can't be read. */
async function olderPart(query: { userId: string; sessionKey: string; maxChars: number }, deps: ResumeDeps): Promise<string | undefined> {
  let summaries: Array<{ summary: string }>;
  try {
    summaries = await deps.readSummaries({ userId: query.userId, sessionKey: query.sessionKey });
  } catch (err) {
    deps.log(`[memory] couldn't read the summaries of ${query.sessionKey}, it resumes without them: ${String(err)}`);
    return undefined;
  }
  const budget = Math.floor(query.maxChars / SUMMARY_SHARE);
  const picked: string[] = [];
  let chars = 0;
  for (const { summary } of [...summaries].reverse()) {
    const cost = summary.length + (picked.length > 0 ? SUMMARY_SEPARATOR.length : 0);
    if (chars + cost > budget) break;
    chars += cost;
    picked.unshift(summary);
  }
  return picked.length > 0 ? picked.join(SUMMARY_SEPARATOR) : undefined;
}

/** `messages` without their oldest ones until they fit `maxChars`, still opening with a user message. */
function trimToFit(messages: Message[], maxChars: number): Message[] {
  let start = 0;
  let chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  while (start < messages.length && chars > maxChars) {
    chars -= messages[start]!.content.length;
    start += 1;
  }
  while (start < messages.length && messages[start]!.role !== "user") start += 1;
  return messages.slice(start);
}
