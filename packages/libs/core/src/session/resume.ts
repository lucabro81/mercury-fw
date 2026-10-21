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
import { formatTurnStamp } from "./turn-stamp.ts";

/** What resuming reads, and where it says what it did. */
export type ResumeDeps = {
  /** The conversation's newest messages within `maxChars` (`listVerbatimTail`). */
  readTail: (query: { userId: string; sessionKey: string; maxChars: number }) => Promise<VerbatimTail>;
  /** The conversation's episodic summaries with when each was written, oldest first (`getEpisodicSummariesBySession`). */
  readSummaries: (query: { userId: string; sessionKey: string }) => Promise<Array<{ summary: string; timestamp: string }>>;
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

/** How much of the budget a partial tail leaves to the summary of what came before it, at least. */
const SUMMARY_SHARE = 4;

const SUMMARY_SEPARATOR = "\n\n";

type TailMessage = VerbatimTail["messages"][number];

/**
 * The conversation `sessionKey` of the person `userId`, rebuilt within
 * `maxChars`, or undefined when there's nothing to resume (a budget of 0 or
 * less, nothing archived, or an archive that can't be read). A tail that
 * reaches the conversation's start comes back alone. Otherwise the tail keeps
 * three quarters of the budget at most, still opening with what the person
 * said, and the summaries of what came before it take what's left. With
 * `timeZone` (the turn's), the person's messages come back stamped with when
 * they were archived, as the live turns reached the model (#293).
 */
export async function resumeConversation(
  query: { userId: string; sessionKey: string; maxChars: number },
  deps: ResumeDeps,
  timeZone?: string,
): Promise<ResumedConversation | undefined> {
  if (query.maxChars <= 0) return undefined;
  let tail: VerbatimTail;
  try {
    tail = await deps.readTail(query);
  } catch (err) {
    deps.log(`[memory] couldn't resume ${query.sessionKey}, it starts without its earlier messages: ${String(err)}`);
    return undefined;
  }

  let kept = tail.messages;
  let summary: string | undefined;
  if (!tail.complete) {
    const trimmed = trimToFit(tail, query.maxChars - Math.floor(query.maxChars / SUMMARY_SHARE));
    kept = trimmed.messages;
    const left = query.maxChars - kept.reduce((sum, m) => sum + m.content.length, 0);
    summary = await summaryBefore(trimmed, left, query, deps);
  }
  const messages: Message[] = kept.map((m) => ({
    role: m.role,
    content: timeZone === undefined || m.role !== "user" ? m.content : `${formatTurnStamp(new Date(m.timestamp), timeZone)}${m.content}`,
  }));
  if (messages.length === 0 && summary === undefined) return undefined;

  deps.log(`[memory] resumed ${query.sessionKey}: ${messages.length} messages, ${summary === undefined ? "no summary" : "summary"}`);
  return summary === undefined ? { messages } : { summary, messages };
}

/**
 * The summaries of what came before `tail`, joined oldest first, within
 * `maxChars`; undefined when none fits or they can't be read. A summary
 * covers what was said up to when it was written, so the ones written before
 * the tail started qualify, plus the first one written after, only when the
 * others stop short of what the tail left out: past that, a summary would
 * repeat what the tail already holds. They're taken newest first and stop at
 * the first that doesn't fit, so what comes back has no gap.
 */
async function summaryBefore(
  tail: { messages: TailMessage[]; leftOutAt?: string },
  maxChars: number,
  query: { userId: string; sessionKey: string },
  deps: ResumeDeps,
): Promise<string | undefined> {
  let summaries: Array<{ summary: string; timestamp: string }>;
  try {
    summaries = await deps.readSummaries({ userId: query.userId, sessionKey: query.sessionKey });
  } catch (err) {
    deps.log(`[memory] couldn't read the summaries of ${query.sessionKey}, it resumes without them: ${String(err)}`);
    return undefined;
  }
  const tailStart = tail.messages[0]?.timestamp;
  let eligible = summaries;
  if (tailStart !== undefined) {
    const after = summaries.findIndex((s) => s.timestamp > tailStart);
    if (after !== -1) {
      const covered = after > 0 && tail.leftOutAt !== undefined && summaries[after - 1]!.timestamp >= tail.leftOutAt;
      eligible = summaries.slice(0, covered ? after : after + 1);
    }
  }
  const picked: string[] = [];
  let chars = 0;
  for (const { summary } of [...eligible].reverse()) {
    const cost = summary.length + (picked.length > 0 ? SUMMARY_SEPARATOR.length : 0);
    if (chars + cost > maxChars) break;
    chars += cost;
    picked.unshift(summary);
  }
  return picked.length > 0 ? picked.join(SUMMARY_SEPARATOR) : undefined;
}

/** `tail` without its oldest messages until it fits `maxChars`, still opening with a user message, and when the newest it left out was written. */
function trimToFit(tail: VerbatimTail, maxChars: number): { messages: TailMessage[]; leftOutAt?: string } {
  const messages = tail.messages;
  let start = 0;
  let chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  while (start < messages.length && chars > maxChars) {
    chars -= messages[start]!.content.length;
    start += 1;
  }
  while (start < messages.length && messages[start]!.role !== "user") start += 1;
  const leftOutAt = start > 0 ? messages[start - 1]!.timestamp : tail.leftOutAt;
  return leftOutAt === undefined ? { messages: messages.slice(start) } : { messages: messages.slice(start), leftOutAt };
}
