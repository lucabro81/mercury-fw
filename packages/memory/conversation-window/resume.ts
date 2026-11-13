/**
 * Picking a conversation up again (#163): a channel where one person keeps
 * many conversations and reopens them whenever they want (HTTP) never ends
 * one, but the open window is only a cache the core frees when the session
 * goes idle. When the conversation comes back, this rebuilds what the model
 * sees the way a compression would: the summary of its older part (what the
 * window was given to read them with, `earlier`: the memory's summaries of
 * this conversation) plus its newest messages, verbatim, within a budget.
 *
 * Reads are injected (the archive and the summaries), and everything here
 * fails soft: a conversation that can't be rebuilt starts empty.
 */
import { formatTurnStamp } from "@mercury-fw/plugin-types";
import { DEFAULT_MAX_CHARS, type Message, type ResumedConversation } from "./history.ts";
import { tailChars, type Tail, type TailMessage } from "./tail.ts";

/** What resuming reads, and where it says what it did. */
export type ResumeDeps = {
  /** The conversation's newest messages within `maxChars` (`readTail`). */
  readTail: (query: { userId: string; sessionKey: string; maxChars: number }) => Promise<Tail>;
  /** The conversation's summaries with when each was written, oldest first; absent, the tail takes the whole budget. */
  readSummaries?: (query: { userId: string; sessionKey: string }) => Promise<Array<{ summary: string; timestamp: string }>>;
  log: (message: string) => void;
};

/** How much of a reopened conversation comes back by default: half of what the window holds before compressing, so a few turns fit before the first compression. */
export const DEFAULT_RESUME_MAX_CHARS = DEFAULT_MAX_CHARS / 2;

/** The budget for reopening a conversation: the channel's own, or else the window's (`ownMaxChars`). */
export function resumeBudget(reopen: { maxChars?: number }, ownMaxChars: number): number {
  return reopen.maxChars ?? ownMaxChars;
}

/** How much of the budget a partial tail leaves to the summary of what came before it, at least. */
const SUMMARY_SHARE = 4;

const SUMMARY_SEPARATOR = "\n\n";

/**
 * The conversation `sessionKey` of the person `userId`, rebuilt within
 * `maxChars`, or undefined when there's nothing to resume (a budget of 0 or
 * less, nothing archived, or an archive that can't be read). A tail that
 * reaches the conversation's start comes back alone, and so does one with no
 * summaries to read. Otherwise the tail keeps three quarters of the budget at
 * most, still opening with what the person said, and the summaries of what
 * came before it take what's left. With
 * `timeZone` (the turn's), the person's messages come back stamped with when
 * they were archived, as the live turns reached the model (#293).
 */
export async function resumeConversation(
  query: { userId: string; sessionKey: string; maxChars: number },
  deps: ResumeDeps,
  timeZone?: string,
): Promise<ResumedConversation | undefined> {
  if (query.maxChars <= 0) return undefined;
  let tail: Tail;
  try {
    tail = await deps.readTail(query);
  } catch (err) {
    deps.log(`[conversation-window] couldn't resume ${query.sessionKey}, it starts without its earlier messages: ${String(err)}`);
    return undefined;
  }

  // Stamped before trimming, so the stamps count toward the budget.
  const stamped: Tail =
    timeZone === undefined
      ? tail
      : {
          ...tail,
          messages: tail.messages.map((m) =>
            // A timestamp that isn't a date leaves its message unstamped, never the turn failed.
            m.role === "user" && !Number.isNaN(Date.parse(m.timestamp))
              ? { ...m, content: `${formatTurnStamp(new Date(m.timestamp), timeZone)}${m.content}` }
              : m,
          ),
        };
  let kept = stamped.messages;
  let summary: string | undefined;
  if (!stamped.complete && deps.readSummaries !== undefined) {
    const trimmed = trimToFit(stamped, query.maxChars - Math.floor(query.maxChars / SUMMARY_SHARE));
    kept = trimmed.messages;
    const left = query.maxChars - kept.reduce((sum, m) => sum + tailChars(m), 0);
    summary = await summaryBefore(trimmed, left, query, deps.readSummaries, deps.log);
  }
  const messages: Message[] = kept.map((m) =>
    m.calls === undefined ? { role: m.role, content: m.content } : { role: m.role, content: m.content, calls: m.calls },
  );
  if (messages.length === 0 && summary === undefined) return undefined;

  deps.log(`[conversation-window] resumed ${query.sessionKey}: ${messages.length} messages, ${summary === undefined ? "no summary" : "summary"}`);
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
  readSummaries: NonNullable<ResumeDeps["readSummaries"]>,
  log: (message: string) => void,
): Promise<string | undefined> {
  let summaries: Array<{ summary: string; timestamp: string }>;
  try {
    summaries = await readSummaries({ userId: query.userId, sessionKey: query.sessionKey });
  } catch (err) {
    log(`[conversation-window] couldn't read the summaries of ${query.sessionKey}, it resumes without them: ${String(err)}`);
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
function trimToFit(tail: Tail, maxChars: number): { messages: TailMessage[]; leftOutAt?: string } {
  const messages = tail.messages;
  let start = 0;
  let chars = messages.reduce((sum, m) => sum + tailChars(m), 0);
  while (start < messages.length && chars > maxChars) {
    chars -= tailChars(messages[start]!);
    start += 1;
  }
  while (start < messages.length && messages[start]!.role !== "user") start += 1;
  const leftOutAt = start > 0 ? messages[start - 1]!.timestamp : tail.leftOutAt;
  return leftOutAt === undefined ? { messages: messages.slice(start) } : { messages: messages.slice(start), leftOutAt };
}
