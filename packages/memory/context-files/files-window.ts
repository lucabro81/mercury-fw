/**
 * The window for `overflow: "files"`: like `conversation-window`'s, it holds
 * the messages the model reads on every call under `maxChars`, but past it
 * the older messages go to a history file of the session instead of a
 * summary. What came before the last `keepRecent` exchanges (an exchange is a
 * person's message and the answers after it, the current one included) is
 * written to the file, one line per message and one per past call, and
 * dropped from the window; the index (`turnIndex`) lists the file. A moved
 * message stays capturable: what the plugins hear of the session is whole.
 *
 * A file that can't be written leaves the window as it was, past its size;
 * the next message tries again, and the report says the move failed.
 *
 * Used by: `index.ts`, for a profile with `overflow: "files"`.
 */
import type { CallRecord, CompressionReport } from "@mercury-fw/plugin-types";
import { messageChars, type ResumedConversation, type Window } from "@mercury-fw/conversation-window";
import type { SessionFiles } from "./session-files.ts";

type Message = ReturnType<Window["getMessages"]>[number];

export type FilesWindowOptions = {
  files: SessionFiles;
  /** How many characters of messages the window holds before it moves the older ones. */
  maxChars: number;
  /** How many exchanges always stay, the current one included (1 or more). */
  keepRecent: number;
  /** What a reopening brought back: its summary leads the window and its messages open it. Already in memory, so never capturable. */
  resumed?: ResumedConversation;
  /** The clock a report's duration is measured on. */
  now?: () => number;
};

/** How many characters of the first message a history file's label shows. */
const LABEL_CHARS = 40;

/** One line of a past call: tool, input and result, as JSON. */
function callLine(call: CallRecord): string {
  return `[call] ${call.toolName} ${JSON.stringify(call.input)} → ${JSON.stringify(call.result)}`;
}

/** `messages` as a history file: one line per message, its calls under it. */
function historyText(messages: Message[]): string {
  return messages
    .flatMap((m) => [`[${m.role}] ${m.content.replaceAll("\n", " ")}`, ...(m.calls ?? []).map(callLine)])
    .join("\n");
}

/** The window; see the module comment. */
export function createFilesWindow(opts: FilesWindowOptions): Window {
  const now = opts.now ?? Date.now;
  let messages: Message[] = [...(opts.resumed?.messages ?? [])];
  const summary = opts.resumed?.summary || undefined;
  let restoredCount = messages.length;
  // The messages this session added that went to a file: still capturable, the plugins hearing of the session see them.
  let moved: Message[] = [];

  /** Where the last `keepRecent` exchanges start. */
  function keptFrom(): number {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user" && ++seen === opts.keepRecent) return i;
    }
    return 0;
  }

  async function add(message: Message): Promise<CompressionReport | void> {
    messages.push(message);
    if (messages.reduce((sum, m) => sum + messageChars(m), 0) <= opts.maxChars) return;
    const from = keptFrom();
    if (from === 0) return;
    const batch = messages.slice(0, from);
    const startedAt = now();
    const charsBefore = batch.reduce((sum, m) => sum + m.content.length, 0);
    const first = batch.find((m) => m.role === "user") ?? batch[0]!;
    const label = `${batch.length} messages, from "${first.content.slice(0, LABEL_CHARS)}"`;
    try {
      await opts.files.write("history", historyText(batch), label);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { messages: batch.length, charsBefore, durationMs: now() - startedAt, outcome: "failed", error };
    }
    messages = messages.slice(from);
    moved = [...moved, ...batch.slice(Math.min(restoredCount, batch.length))];
    restoredCount = Math.max(0, restoredCount - batch.length);
    return { messages: batch.length, charsBefore, charsAfter: 0, durationMs: now() - startedAt, outcome: "done" };
  }

  function getMessages(): Message[] {
    return [...(summary === undefined ? [] : [{ role: "assistant" as const, content: `Earlier conversation summary: ${summary}` }]), ...messages];
  }

  return {
    addUserMessage: (content, context) => add(context === undefined ? { role: "user", content } : { role: "user", content, context }),
    addAssistantMessage: (content, calls) => add(calls !== undefined && calls.length > 0 ? { role: "assistant", content, calls } : { role: "assistant", content }),
    replaceLastAssistantMessage: (content) => {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") messages[messages.length - 1] = { ...last, content };
    },
    getMessages,
    getCapturable: () => [...moved, ...messages.slice(restoredCount)],
    getCharCount: () => getMessages().reduce((sum, m) => sum + messageChars(m), 0),
  };
}
