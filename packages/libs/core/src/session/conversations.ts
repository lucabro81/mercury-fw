/**
 * The open conversations, one per session (#393): what each turn reads and
 * adds to, opened at a session's first turn and kept until it closes.
 *
 * Who keeps a session's conversation is the plugin its first person's
 * context profile names (`context.profiles.<p>.conversation`, a
 * `ConversationOwner`); a profile that names none keeps no conversation, and
 * each turn reads only itself (`createTurnOnlyConversation`). Either way the
 * core adds what the person's earlier conversations left for this one (the
 * primer), which is memory and not the conversation's, and records what a
 * compression the conversation reports did (`onCompressed`).
 *
 * Used by: `compose.ts`, which hands `open` to the turn runner and `get`/`close`
 * to the idle-session sweep.
 */
import type { CompressionReport, Conversation, ConversationOpen, ConversationOwner } from "@mercury-fw/plugin-types";
import type { TurnWho } from "../identity/people.ts";
import type { ContextPrimer } from "./context-primer.ts";
import { createTurnOnlyConversation, type SessionHistory } from "./history.ts";

/** What a session's first turn tells about it: its key, whether someone vouched for who writes (`userId` then their key), the channel's `resume`, the turn's time zone. */
export type OpenRequest = {
  sessionKey: string;
  tracked: boolean;
  userId?: string;
  resume?: { maxChars?: number };
  timeZone?: string;
};

export type ConversationsDeps = {
  /** The plugin keeping conversations in `who`'s profile, when it names one. */
  ownerFor: (who: TurnWho) => ConversationOwner | undefined;
  /** What the person's earlier conversations left for this one (see `context-primer.ts`). */
  primerFor: (userId: string, reopen: OpenRequest["resume"]) => Promise<ContextPrimer | undefined>;
  /** Where a primer that failed is told; the console when absent. */
  log?: (message: string) => void;
  /** Told when adding a message made the session's conversation shorten what came before (the `history.compressed` event). */
  onCompressed?: (sessionKey: string, report: CompressionReport) => void;
};

export type Conversations = {
  /** The session's conversation: the one already open, else a new one for `who`. Rejects when it can't be opened. */
  open: (who: TurnWho, req: OpenRequest) => Promise<SessionHistory>;
  /** The session's open conversation, if any. */
  get: (sessionKey: string) => SessionHistory | undefined;
  /** Forgets the session's conversation, telling the plugin that kept it. */
  close: (sessionKey: string) => void;
};

/** What the plugin is asked to open for `req`: nothing of a person, nor a reopening, when nobody vouched for who writes. */
function openRequest(req: OpenRequest): ConversationOpen {
  if (!req.tracked || req.userId === undefined) return { sessionKey: req.sessionKey };
  return {
    sessionKey: req.sessionKey,
    person: { key: req.userId },
    ...(req.resume === undefined ? {} : { reopen: req.resume }),
    ...(req.timeZone === undefined ? {} : { timeZone: req.timeZone }),
  };
}

/** Builds the open conversations; see the module comment. */
export function createConversations(deps: ConversationsDeps): Conversations {
  const open = new Map<string, { history: SessionHistory; owner?: ConversationOwner }>();

  return {
    async open(who, req) {
      const kept = open.get(req.sessionKey);
      if (kept !== undefined) return kept.history;
      const owner = deps.ownerFor(who);
      const conversation: Conversation =
        owner === undefined ? createTurnOnlyConversation() : await owner.open(openRequest(req));
      // The conversation is open: a primer that fails never leaves it open and unknown.
      const primer =
        req.tracked && req.userId !== undefined
          ? await deps.primerFor(req.userId, req.resume).catch((err: unknown) => {
              (deps.log ?? console.error)(`[memory] the primer failed, the conversation starts without: ${err instanceof Error ? err.message : String(err)}`);
              return undefined;
            })
          : undefined;
      /** Passes on what the conversation reports of a compression, and resolves when the add is done. */
      const told = async (added: Promise<CompressionReport | void>): Promise<void> => {
        const report = await added;
        if (report) deps.onCompressed?.(req.sessionKey, report);
      };
      const history: SessionHistory = {
        getMessages: () => conversation.getMessages(),
        addUserMessage: (content, context) => told(conversation.addUserMessage(content, context)),
        addAssistantMessage: (content, calls) => told(conversation.addAssistantMessage(content, calls)),
        replaceLastAssistantMessage: (content) => conversation.replaceLastAssistantMessage(content),
        getCharCount: () => conversation.getCharCount(),
        getCapturable: () => conversation.getCapturable?.() ?? conversation.getMessages(),
        primer: () => (primer && (primer.current || primer.recap) ? primer : undefined),
      };
      open.set(req.sessionKey, owner === undefined ? { history } : { history, owner });
      return history;
    },
    get: (sessionKey) => open.get(sessionKey)?.history,
    close(sessionKey) {
      const kept = open.get(sessionKey);
      if (kept === undefined) return;
      open.delete(sessionKey);
      kept.owner?.close?.(sessionKey);
    },
  };
}
