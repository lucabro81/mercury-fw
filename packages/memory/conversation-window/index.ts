/**
 * `@mercury-fw/conversation-window`: keeps each conversation for the model.
 * One window per session holds the recent messages; past a size it shortens
 * what came before the current turn (a summary, or dropping the oldest), and
 * a conversation its client reopens comes back from the archive (the
 * conversation store), with the summaries of what the archive's tail leaves
 * out when it was given something to read them with (`earlier`). It also
 * gives the model `recall_tool_calls`, what it ran earlier in the
 * conversation, from the core's tool log.
 *
 * An app declares it in `plugins` and names it as a context profile's
 * `conversation`; a profile that names none keeps no conversation, and each
 * turn reads only itself.
 */
import { PLUGIN_API_VERSION, type ConversationOpen, type Plugin, type PluginNeed } from "@mercury-fw/plugin-types";
import { createWindow, DEFAULT_MAX_CHARS, type Overflow } from "./history.ts";
import { createRecallToolCalls, RECALL_PROMPT_FRAGMENT } from "./recall-tool.ts";
import { resumeBudget, resumeConversation } from "./resume.ts";
import { createSummarizer } from "./summarizer.ts";
import { readTail } from "./tail.ts";

export { DEFAULT_MAX_CHARS, type Overflow } from "./history.ts";

/**
 * What reads the summaries of a conversation's older part, for one the window
 * brings back: the person's and the conversation's, oldest first, each with
 * when it was written. The memory's summaries of each conversation are this.
 */
export type EarlierSummaries = {
  summariesOf: (q: { person: string; sessionKey: string }) => Promise<Array<{ summary: string; timestamp: string }>>;
};

export type ConversationWindowOptions = {
  /** How many characters of messages a window holds before it shortens what came before the current turn: 60000 when absent. */
  maxChars?: number;
  /** How it shortens: `summarize` (the default) folds the older messages into a summary on the turn's model; `truncate` drops them. */
  overflow?: Overflow;
  /**
   * How much of a reopened conversation comes back (`maxChars`, when the
   * channel sets no budget of its own: half of the window's size when
   * absent, 0 for nothing), or `false` never to read the archive.
   */
  reopen?: { maxChars?: number } | false;
  /** What reads the summaries of a reopened conversation's older part; without it, the archive's newest messages come back alone. */
  earlier?: EarlierSummaries;
};

/** The plugin's texts, in English. */
export const CONVERSATION_WINDOW_MESSAGES = {
  "conversation-window.status.recall": "Checking my memory…",
};

/** Whether `n` is a whole number from `min` up. */
function wholeFrom(n: number, min: number): boolean {
  return Number.isInteger(n) && n >= min;
}

/** The conversation-window plugin; see the module comment. Throws on options that can't be. */
export function conversationWindow(options: ConversationWindowOptions = {}): Plugin {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!wholeFrom(maxChars, 1)) throw new Error("conversationWindow: maxChars must be a whole number above 0");
  const reopen = options.reopen;
  if (reopen !== false && reopen?.maxChars !== undefined && !wholeFrom(reopen.maxChars, 0)) {
    throw new Error("conversationWindow: reopen.maxChars must be a whole number from 0 up");
  }
  const ownReopenChars = reopen === false ? 0 : (reopen?.maxChars ?? Math.floor(maxChars / 2));
  const needs: PluginNeed[] = reopen === false ? [] : ["conversationStore"];

  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "conversation-window",
    description: "Keeps each conversation's recent messages for the model, shortening what came before when it grows long, and brings back a conversation its person reopens.",
    actsAs: "anyone",
    needs,
    messages: CONVERSATION_WINDOW_MESSAGES,
    systemPromptFragment: RECALL_PROMPT_FRAGMENT,
    build: (ctx) => {
      const summarize = createSummarizer(ctx.model);
      const earlier = options.earlier;

      /** What a reopening brings back for `req`, if anything. */
      async function resumedFor(req: ConversationOpen) {
        const store = ctx.conversations;
        if (reopen === false || store === undefined || req.person === undefined || req.reopen === undefined) return undefined;
        const person = req.person.key;
        return resumeConversation(
          { userId: person, sessionKey: req.sessionKey, maxChars: resumeBudget(req.reopen, ownReopenChars) },
          {
            readTail: (q) => readTail(store, q),
            ...(earlier === undefined ? {} : { readSummaries: (q: { sessionKey: string }) => earlier.summariesOf({ person, sessionKey: q.sessionKey }) }),
            log: ctx.log,
          },
          req.timeZone,
        );
      }

      return {
        conversation: {
          open: async (req) => {
            const resumed = await resumedFor(req);
            return createWindow({ summarize, maxChars, ...(options.overflow === undefined ? {} : { overflow: options.overflow }), ...(resumed === undefined ? {} : { resumed }) });
          },
        },
        sessionTools: (sctx) => {
          const toolLog = ctx.toolLog;
          if (toolLog === undefined || sctx.person === null) return {};
          return createRecallToolCalls({ toolLog, sessionKey: sctx.sessionKey, person: sctx.person.key });
        },
        toolStatusDescribers: {
          recall_tool_calls: (_input, t) => t("conversation-window.status.recall"),
        },
      };
    },
  };
}
