/**
 * The open conversations, one per session (#393): what each turn reads and
 * adds to, opened at a session's first turn and kept until it closes.
 *
 * Who keeps a session's conversation is the plugin its first person's
 * context profile names (`context.profiles.<p>.conversation`, a
 * `ConversationOwner`); a profile that names none keeps today's window inside
 * the core (`internal`), until that window becomes a plugin of its own. With
 * a plugin, the core still adds what the person's earlier conversations left
 * for this one (the primer), which is memory and not the conversation's.
 *
 * Used by: `compose.ts`, which hands `open` to the turn runner and `get`/`close`
 * to the idle-session sweep.
 */
import type { ConversationOpen, ConversationOwner } from "@mercury-fw/plugin-types";
import type { TurnWho } from "../identity/people.ts";
import type { ContextPrimer } from "./context-primer.ts";
import type { SessionHistory } from "./history.ts";

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
  /** Today's window, for a profile that names no plugin. */
  internal: (req: OpenRequest) => Promise<SessionHistory>;
  /** What the person's earlier conversations left for this one (see `context-primer.ts`). */
  primerFor: (userId: string, reopen: OpenRequest["resume"]) => Promise<ContextPrimer | undefined>;
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
      if (owner === undefined) {
        const history = await deps.internal(req);
        open.set(req.sessionKey, { history });
        return history;
      }
      const conversation = await owner.open(openRequest(req));
      const primer = req.tracked && req.userId !== undefined ? await deps.primerFor(req.userId, req.resume) : undefined;
      const history: SessionHistory = {
        getMessages: () => conversation.getMessages(),
        addUserMessage: (content, context) => conversation.addUserMessage(content, context),
        addAssistantMessage: (content, calls) => conversation.addAssistantMessage(content, calls),
        replaceLastAssistantMessage: (content) => conversation.replaceLastAssistantMessage(content),
        getCharCount: () => conversation.getCharCount(),
        getCapturable: () => conversation.getCapturable?.() ?? conversation.getMessages(),
        primer: () => (primer && (primer.current || primer.recap) ? primer : undefined),
      };
      open.set(req.sessionKey, { history, owner });
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
