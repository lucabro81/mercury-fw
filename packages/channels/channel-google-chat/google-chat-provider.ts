/**
 * The registered Chat app's `Provider` — replaces the retired
 * impersonation-based channel (`google-chat-client.ts`/`google-chat-events.ts`/
 * `google-chat-streamer.ts`/`google-chat-message-buffer.ts`, all deleted)
 * wholesale, not as an adapter over it. Built directly against the
 * chat-app model: `chat.bot`-scoped service-account auth
 * (`google-chat-app-client.ts`), a single Pub/Sub subscription for the
 * whole app (no more per-space Workspace Events subscriptions — a real
 * simplification the old impersonation path needed and this one doesn't),
 * and a real per-app bot identity.
 *
 * Session key is `space:sender` — same as the retired channel's own key
 * (see `deriveSessionKey` for why a thread-keyed variant, tried initially,
 * broke conversation continuity in DMs).
 *
 * The `[Da: X]` sender marker no longer needs a People-API round trip: a
 * registered app's `MESSAGE` event already carries `sender.displayName`
 * directly (confirmed live against a real captured event earlier this
 * session) — `resolveSenderName`/`getUser`/the `resolved-name.md` wiki
 * cache are not used by this provider at all.
 */
import {
  createTokenSource,
  sendMessage,
  sendCard,
  updateCard,
  getOrCreateDmSpace,
  type ServiceAccountCredentials,
  type TokenSource,
  type ChatCard,
  type ChatCardSection,
} from "./google-chat-app-client.ts";
import { openSubscription, type PubSubSubscription, type StreamMessage } from "./google-chat-pubsub-stream.ts";
import { splitForSendLimit } from "./google-chat-message-buffer.ts";
import {
  detectLoginRequired,
  detectPendingConfirmation,
  loginLinkText,
  NO_REPLY,
  type ChannelI18n,
  type ChannelRuntimeContext,
  type ConfirmReply,
  type Translate,
  type LoginRequest,
  type PendingConfirmation,
  type ToolOutcome,
  type Provider,
  type HandleTurn,
  type TurnSink,
  type Principal,
} from "@mercury-fw/channel-types";
import { englishChat } from "./messages.ts";

/**
 * Builds the confirmation card sent when a step stages an irreversible
 * command (see `pending-confirmation.ts`), one button per choice it offers
 * (a single "Confirm" for a plain staging, in the person's language: `t`).
 * Each button's parameters carry the token, so a click routes straight into
 * the same confirmation path
 * a bare token typed on the terminal uses (see `onCardClick`'s `confirm`
 * case, below) — the user never has to see or type the token themselves —
 * plus its label and the summary, so the click can turn the card into
 * `buildChosenCard` without the channel keeping any state.
 */
function buildConfirmCard(pending: PendingConfirmation, t: Translate): ChatCard {
  return {
    header: { title: t("google-chat.confirm.title") },
    sections: [
      {
        widgets: [
          { textParagraph: { text: `\`${pending.summary}\`` } },
          {
            buttonList: {
              buttons: pending.choices.map((choice) => ({
                text: choice.label || t("google-chat.confirm.button"),
                onClick: {
                  action: {
                    function: "confirm",
                    parameters: [
                      { key: "token", value: choice.token },
                      { key: "label", value: choice.label || t("google-chat.confirm.button") },
                      { key: "summary", value: pending.summary },
                    ],
                  },
                },
              })),
            },
          },
        ],
      },
    ],
  };
}

/** The confirmation card once a choice is taken: the same request, the choice instead of the buttons. */
function buildChosenCard(summary: string, label: string | undefined, t: Translate): ChatCard {
  return {
    header: { title: t("google-chat.confirm.title") },
    sections: [
      {
        widgets: [
          { textParagraph: { text: `\`${summary}\`` } },
          { textParagraph: { text: label === undefined ? t("google-chat.confirm.taken") : t("google-chat.confirm.chosen", { label }) } },
        ],
      },
    ],
  };
}

/** The card that shows a person the link to log in to a service a plugin acts on as them: one button that opens it. */
function buildLoginCard(login: LoginRequest, t: Translate): ChatCard {
  return {
    sections: [{ widgets: [{ buttonList: { buttons: [{ text: loginLinkText(login, t), onClick: { openLink: { url: login.url } } }] } }] }],
  };
}

/** Where a status card stands: in progress, ended as a tool ends, or stopped by the person. */
type CardStatus = "loading" | ToolOutcome | "stopped";

/** A card's status line, in the person's language. */
function statusLine(status: CardStatus, t: Translate): string {
  return t(`google-chat.status.${status}`);
}

/**
 * The section that carries the Stop button on a card in progress: a section of
 * its own, outside the collapsible one, so it's visible without expanding
 * anything. A click comes back as `CARD_CLICKED` with the `stop` parameter
 * set to `turn`, the id of the turn the card belongs to (`parseChatEvent`), so
 * a button left on an older card never stops a newer turn. A card's final
 * patch rebuilds it without this section, so the button goes away with the
 * turn.
 */
function stopSection(t: Translate, turn: string): ChatCardSection {
  return {
    widgets: [
      {
        buttonList: {
          buttons: [{ text: t("google-chat.stop.button"), onClick: { action: { function: "stop", parameters: [{ key: "stop", value: turn }] } } }],
        },
      },
    ],
  };
}

/**
 * A tool-call/reasoning status card: `label` is a section `header`
 * (Google Chat's native accordion title, always visible regardless of
 * collapse state), `detail`/status are the two widgets folded behind it —
 * `uncollapsibleWidgetsCount: 0` means both start collapsed. Sent once as
 * "loading" (`createSink`'s `onToolStart`/first `onReasoningChunk`), then
 * the very same message is patched in place to its final status
 * (`onToolFinish`/`onReasoningEnd`) via `updateCardFn` — never a second
 * message.
 *
 * The status is appended to the title too, not just left inside the
 * collapsed body: a title stuck reading "Reading Jira…" (present
 * progressive) forever, even once the card's own body says "Done.", looked
 * like the card never updated at all — confirmed live (the body did patch,
 * only the title didn't change).
 *
 * Native `collapsible` state is client-side only and resets to collapsed
 * on every PATCH — confirmed live. Harmless for a card patched exactly
 * twice (send, then one final patch): reasoning cards used to be patched
 * every ~1s while streaming and forcibly kept open (`alwaysExpanded`) to
 * work around it, which made the reset bug moot but leaked the
 * in-progress reasoning text into a card the user might reopen mid-stream.
 * Simpler fix, not just a workaround: `createSink`'s reasoning handling no
 * longer patches this card at all while loading (see `onReasoningChunk`) —
 * detail is only ever revealed in the single final patch, at which point
 * nothing patches the message again, so the native toggle can never be
 * reset out from under the user again either.
 */
function buildToolCallCard(label: string, detail: string, status: CardStatus, t: Translate, turn: string): ChatCard {
  return {
    sections: [
      {
        header: status === "loading" ? label : `${label} ${statusLine(status, t)}`,
        collapsible: true,
        uncollapsibleWidgetsCount: 0,
        widgets: [{ textParagraph: { text: detail } }, { textParagraph: { text: statusLine(status, t) } }],
      },
      ...(status === "loading" ? [stopSection(t, turn)] : []),
    ],
  };
}

const REASONING_TAIL_CHARS = 4000;

/**
 * Sent immediately when a turn starts, before the model has produced
 * anything at all — covers the real gap (confirmed live, ~10s) between a
 * message arriving and the first visible activity: Ollama's own
 * prompt-prefill/model-load time, which happens before even the first
 * reasoning token, so nothing else would appear on screen until then.
 * Ollama's `/api/generate`/`/api/chat` streaming endpoints don't expose
 * any intermediate loading/prefill event to distinguish finer-grained
 * states here (checked against the API docs) — `load_duration`/
 * `prompt_eval_duration` only appear in the final, non-streamed response.
 * Header is the generic "Status" (not a restatement of the body) so this
 * has somewhere to grow if a genuinely different state ever becomes
 * observable, rather than needing a redesign.
 *
 * Not expandable (no `collapsible`) — there's nothing to fold away. A
 * section with zero widgets renders as a near-empty sliver in Google Chat
 * (confirmed live — a thin grey line, no visible text at all), so this
 * always carries at least one `textParagraph`, same as every other card
 * in this file. If the turn's first reasoning burst arrives,
 * `onReasoningChunk` patches this exact card into the "Thinking…"
 * card in place, rather than sending a second message; otherwise it's
 * left as the last status before the turn's real answer, patched only to
 * take its Stop button away, or to say the person stopped the turn.
 */
function buildReceivingCard(t: Translate, turn: string, state: "loading" | "answered" | "stopped" = "loading"): ChatCard {
  const text = state === "stopped" ? statusLine("stopped", t) : t("google-chat.receiving.text");
  return {
    sections: [
      { header: t("google-chat.receiving.title"), widgets: [{ textParagraph: { text } }] },
      ...(state === "loading" ? [stopSection(t, turn)] : []),
    ],
  };
}

/**
 * Bounds a live-growing reasoning buffer to its most recent
 * `max` characters, prefixed with "…" when truncated — deliberately the
 * opposite direction of `tool-start-hook.ts`'s `truncate()` (which keeps
 * the head, right for a short command): a live stream should show its
 * most recent content as it grows, not freeze on its first N characters.
 */
function tailTruncate(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/**
 * Composite session key: space + sender. Deliberately does NOT include
 * `thread` — confirmed live (two consecutive messages in the same DM
 * conversation produced two different `thread.name` values) that Google
 * Chat assigns a fresh thread to every top-level message in a DM (the DM
 * UI has no way to reply in-thread at all), so a thread-keyed session was
 * a brand new, empty history on every single message. Matches the retired
 * impersonation-based channel's own key exactly. Revisit only once Mercury
 * actually participates in threaded group spaces with a demonstrated need
 * for parallel per-thread conversations — not speculatively.
 */
export function deriveSessionKey(space: string, sender: string): string {
  return `${space}:${sender}`;
}

type RawChatSender = { name?: string; displayName?: string; email?: string; type?: string };
type RawChatEvent = {
  type?: string;
  message?: {
    name?: string;
    text?: string;
    /** The text without the leading @mention of the app, in a space. */
    argumentText?: string;
    space?: { name?: string; type?: string };
    sender?: RawChatSender;
    /** A slash command the message invoked shows up here, with its name. */
    annotations?: Array<{ type?: string; slashCommand?: { commandName?: string } }>;
  };
  action?: { actionMethodName?: string; parameters?: Array<{ key?: string; value?: string }> };
  space?: { name?: string; type?: string };
  user?: RawChatSender;
  /** What the person's Chat client says about them, when the event carries it: `userLocale` is their language (`en-US`), `timeZone.id` the zone they're in (`Europe/Rome`). */
  common?: { userLocale?: string; timeZone?: { id?: string; offset?: number } };
};

export type ParsedMessageEvent = {
  kind: "message";
  text: string;
  messageName: string;
  space: string;
  sender: string;
  senderDisplayName: string | undefined;
  /** The sender's email, which Google vouches for: a person's only, never a bot's. */
  senderEmail: string | undefined;
  /**
   * True only when `space.type` is exactly `"DM"` (the Chat API's shape
   * for a private 1:1 space) — anything else, including a missing field,
   * stays `false` on purpose: a DM is unambiguously addressed to Mercury,
   * everything else keeps the cautious multi-user default. Confirmed
   * live against a real DM event this session.
   */
  isDirectMessage: boolean;
  /** The language of the sender's Chat client (`common.userLocale`), when the event carries it: the turn's language hint. */
  locale?: string;
  /** The time zone of the sender's Chat client (`common.timeZone.id`), when the event carries it: the turn's time zone hint. */
  timeZone?: string;
};

export type ParsedCardClickEvent = {
  kind: "card-click";
  /** The message holding the clicked card, when the event names it. */
  messageName?: string;
  space: string;
  sender: string;
  senderEmail: string | undefined;
  parameters: Record<string, string>;
  /** As on a message (see `ParsedMessageEvent.isDirectMessage`): for the turn a click resumes. */
  isDirectMessage: boolean;
  /** As on a message (see `ParsedMessageEvent.locale`). */
  locale?: string;
  /** As on a message (see `ParsedMessageEvent.timeZone`). */
  timeZone?: string;
};

/**
 * The person asked to stop their running turn: `/stop` (`source: "command"`,
 * the registered slash command or a message reading exactly that), or a click
 * on a card's Stop button (`source: "button"`).
 */
export type ParsedStopEvent = {
  kind: "stop";
  source: "command" | "button";
  space: string;
  sender: string;
  senderEmail: string | undefined;
  /** As on a message (see `ParsedMessageEvent.isDirectMessage`). */
  isDirectMessage: boolean;
  /** As on a message (see `ParsedMessageEvent.locale`): for the reply when there's nothing to stop. */
  locale?: string;
  /** For a click, the turn whose card carried the button: only that turn is stopped. */
  turn?: string;
};

/** The command that stops the session's running turn. */
const STOP_COMMAND = "/stop";

/** Whether a message asks to stop: it invoked the `/stop` slash command, or its text (after any @mention) is exactly `/stop`. */
function isStopMessage(m: NonNullable<RawChatEvent["message"]>): boolean {
  if (m.annotations?.some((a) => a.type === "SLASH_COMMAND" && a.slashCommand?.commandName === STOP_COMMAND)) return true;
  const text = typeof m.argumentText === "string" ? m.argumentText : m.text;
  return text?.trim() === STOP_COMMAND;
}

/** The language the event says the person's client is in, when it says. */
function localeOf(event: RawChatEvent | null | undefined): string | undefined {
  const locale = event?.common?.userLocale;
  return typeof locale === "string" && locale.trim() !== "" ? locale.trim() : undefined;
}

/** The time zone the event says the person's client is in, when it says. */
function timeZoneOf(event: RawChatEvent | null | undefined): string | undefined {
  const id = event?.common?.timeZone?.id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
}

/** The email Google vouches for on `sender`: a person's only (`HUMAN`), never a bot's or an unknown kind's. */
function emailOf(sender: RawChatSender | undefined): string | undefined {
  return typeof sender?.email === "string" && sender.email !== "" && sender.type === "HUMAN" ? sender.email : undefined;
}

/** Parses one decoded Pub/Sub event, or `null` if it isn't a kind this provider acts on. */
export function parseChatEvent(raw: unknown): ParsedMessageEvent | ParsedCardClickEvent | ParsedStopEvent | null {
  const event = raw as RawChatEvent;
  const locale = localeOf(event);
  const timeZone = timeZoneOf(event);
  if (event?.type === "MESSAGE") {
    const m = event.message;
    if (!m || typeof m.name !== "string" || typeof m.text !== "string") return null;
    if (typeof m.space?.name !== "string") return null;
    if (typeof m.sender?.name !== "string") return null;
    if (isStopMessage(m)) {
      return {
        kind: "stop",
        source: "command",
        space: m.space.name,
        sender: m.sender.name,
        senderEmail: emailOf(m.sender),
        isDirectMessage: m.space.type === "DM",
        ...(locale === undefined ? {} : { locale }),
      };
    }
    return {
      kind: "message",
      text: m.text,
      messageName: m.name,
      space: m.space.name,
      sender: m.sender.name,
      senderDisplayName: m.sender.displayName,
      senderEmail: emailOf(m.sender),
      isDirectMessage: m.space.type === "DM",
      ...(locale === undefined ? {} : { locale }),
      ...(timeZone === undefined ? {} : { timeZone }),
    };
  }
  if (event?.type === "CARD_CLICKED") {
    if (typeof event.space?.name !== "string") return null;
    if (typeof event.user?.name !== "string") return null;
    const parameters: Record<string, string> = {};
    for (const p of event.action?.parameters ?? []) {
      if (typeof p.key === "string" && typeof p.value === "string") {
        parameters[p.key] = p.value;
      }
    }
    if (parameters.stop !== undefined) {
      return {
        kind: "stop",
        source: "button",
        turn: parameters.stop,
        space: event.space.name,
        sender: event.user.name,
        senderEmail: emailOf(event.user),
        isDirectMessage: event.space.type === "DM",
        ...(locale === undefined ? {} : { locale }),
      };
    }
    return {
      kind: "card-click",
      ...(typeof event.message?.name === "string" ? { messageName: event.message.name } : {}),
      space: event.space.name,
      sender: event.user.name,
      senderEmail: emailOf(event.user),
      parameters,
      isDirectMessage: event.space.type === "DM",
      ...(locale === undefined ? {} : { locale }),
      ...(timeZone === undefined ? {} : { timeZone }),
    };
  }
  return null;
}

export type CardClickHandler = (
  params: Record<string, string>,
  space: string,
  sender: string,
  senderEmail?: string,
  isDirectMessage?: boolean,
  messageName?: string,
  /** The clicking person's client language (`ParsedCardClickEvent.locale`). */
  locale?: string,
  /** The clicking person's client time zone (`ParsedCardClickEvent.timeZone`). */
  timeZone?: string,
) => Promise<void>;

export type GoogleChatProviderDeps = {
  credentials: ServiceAccountCredentials;
  subscription: string;
  /**
   * Resolves a confirmation token against the core's shared store, injected by
   * the channel loader (`ChannelRuntimeContext.confirm`). Returns what to tell
   * the person, in their language, or `null` when the input wasn't
   * token-shaped. With
   * `resolveConfirmation` below, the channel's whole contact with confirmation:
   * the store, vault and note-writer stay in the core.
   */
  confirm: ChannelRuntimeContext["confirm"];
  /**
   * The structured sibling of `confirm` (`ChannelRuntimeContext.resolveConfirmation`).
   * When it's there, a click resolves through it, and an accepted choice
   * turns its card into the choice taken; without it, a click goes through
   * `confirm` and the card stays as it was.
   */
  resolveConfirmation?: ChannelRuntimeContext["resolveConfirmation"];
  /** The texts the cards show, in each person's language (`ChannelRuntimeContext.i18n`); English when absent. */
  i18n?: ChannelI18n;
  /**
   * Handles a `CARD_CLICKED` event's action parameters. Defaults to resolving
   * the confirm button's token through `deps.confirm` (the same path a bare
   * token typed on the terminal uses) — override only to handle a different
   * card's click shape (e.g. a future `notify-user` disambiguation token), not
   * to change how confirmation itself resolves.
   */
  onCardClick?: CardClickHandler;
  /** Test seams — default to the real client functions bound with a token source built from `credentials`. */
  tokenSourceFn?: (creds: ServiceAccountCredentials) => TokenSource;
  sendMessageFn?: typeof sendMessage;
  sendCardFn?: typeof sendCard;
  updateCardFn?: typeof updateCard;
  getOrCreateDmSpaceFn?: typeof getOrCreateDmSpace;
  /** Test seam — defaults to `openSubscription` (real StreamingPull); tests inject a fake `PubSubSubscription`. */
  subscriptionFn?: (creds: ServiceAccountCredentials, subscription: string) => PubSubSubscription;
  log?: (msg: string) => void;
};

/**
 * A turn's sink, plus what the provider does once the turn has let go:
 * after a stop, `settle` makes the cards say so (the receiving card, or a
 * short message when no card in progress could); after a turn that `failed`
 * (threw, so never reached `finalize`), it takes the receiving card's Stop
 * button away; after an answer, it does nothing.
 */
type StopAwareSink = TurnSink & { settle(failed: boolean): Promise<void> };

export type GoogleChatProvider = Provider & {
  stop(): Promise<void>;
};

/** Builds the registered Google Chat app's `Provider`. */
export function createGoogleChatProvider(deps: GoogleChatProviderDeps): GoogleChatProvider {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const tokenSource = (deps.tokenSourceFn ?? createTokenSource)(deps.credentials);
  const sendMessageFn = deps.sendMessageFn ?? sendMessage;
  const sendCardFn = deps.sendCardFn ?? sendCard;
  const updateCardFn = deps.updateCardFn ?? updateCard;
  const getOrCreateDmSpaceFn = deps.getOrCreateDmSpaceFn ?? getOrCreateDmSpace;
  const subscriptionFn = deps.subscriptionFn ?? openSubscription;
  const clientDeps = { tokenSource };
  const sentMessageNames = new Set<string>();
  /** The texts for `principal`, on the client language `hint`. */
  const textsFor = async (principal: Principal, hint: string | undefined): Promise<Translate> =>
    deps.i18n ? (await deps.i18n.forRequest(principal, hint)).t : englishChat;
  // Per-session serialization: pollOnce's setInterval fires on a fixed
  // clock regardless of whether the previous tick's turn finished, so two
  // overlapping ticks could otherwise both call handleTurn for the SAME
  // session at once — both reading/writing the same SessionHistory
  // concurrently. Scoped by sessionKey only (not global), so a slow turn
  // for one user/space never blocks a different one's.
  const busySessions = new Set<string>();
  const queuedTurns = new Map<string, Array<(signal: AbortSignal, turnId: string) => Promise<void>>>();
  // The running turn, per session: its id (on its cards' Stop buttons) and the abort a stop fires.
  const runningTurns = new Map<string, { id: string; controller: AbortController }>();
  // The turn handler `start` was given, for a turn a card click resumes.
  let activeHandleTurn: HandleTurn | undefined;

  /** Runs `turn` for `sessionKey` now, or after the turns already queued for it, with a signal `stopSession` aborts. */
  async function runInSession(sessionKey: string, turn: (signal: AbortSignal, turnId: string) => Promise<void>): Promise<void> {
    if (busySessions.has(sessionKey)) {
      const queue = queuedTurns.get(sessionKey) ?? [];
      queue.push(turn);
      queuedTurns.set(sessionKey, queue);
      return;
    }
    busySessions.add(sessionKey);
    const controller = new AbortController();
    const id = crypto.randomUUID();
    runningTurns.set(sessionKey, { id, controller });
    try {
      await turn(controller.signal, id);
    } finally {
      runningTurns.delete(sessionKey);
      busySessions.delete(sessionKey);
      const queue = queuedTurns.get(sessionKey);
      const next = queue?.shift();
      if (queue && queue.length === 0) queuedTurns.delete(sessionKey);
      if (next) {
        runInSession(sessionKey, next).catch((err) => log(`[chat] queued turn failed: ${String(err)}`));
      }
    }
  }

  /**
   * Stops `sessionKey`'s running turn and discards every turn queued behind
   * it: they haven't sent anything yet, so they just never run. With `turnId`
   * (a button's), only when that's the turn running: a click on an older
   * card stops nothing. Returns whether there was a turn to stop.
   */
  function stopSession(sessionKey: string, turnId?: string): boolean {
    const running = runningTurns.get(sessionKey);
    if (running === undefined || running.controller.signal.aborted) return false;
    if (turnId !== undefined && turnId !== running.id) return false;
    queuedTurns.delete(sessionKey);
    running.controller.abort();
    return true;
  }

  /**
   * Runs one turn on `handleTurn` with the session's stop signal, then
   * settles its cards once it has let go (`StopAwareSink.settle`).
   */
  async function runTurn(
    handleTurn: HandleTurn,
    turn: Parameters<HandleTurn>[0],
    sink: StopAwareSink,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await handleTurn({ ...turn, abortSignal: signal }, sink);
    } catch (err) {
      await sink.settle(true);
      throw err;
    }
    await sink.settle(false);
  }

  /** Resumes the session's turn after a confirmation whose result went back to the model (`ConfirmReply.resume`). */
  async function resumeTurn(
    handleTurn: HandleTurn,
    space: string,
    principal: Principal,
    isDirectMessage: boolean,
    locale: string | undefined,
    timeZone: string | undefined,
  ): Promise<void> {
    const sessionKey = deriveSessionKey(space, principal.id);
    const t = await textsFor(principal, locale);
    return runInSession(sessionKey, (signal, turnId) =>
      runTurn(
        handleTurn,
        {
          channel: "google-chat",
          multiUser: !isDirectMessage,
          text: "",
          sessionKey,
          principal,
          logPrefix: `[chat:${space}:${principal.id}] `,
          resumeAfterConfirm: true,
          ...(locale === undefined ? {} : { languageHint: locale }),
          ...(timeZone === undefined ? {} : { timeZoneHint: timeZone }),
        },
        createSink(space, { user: principal.id, isDirectMessage }, t, signal, turnId),
        signal,
      ),
    );
  }

  /**
   * Default `onCardClick`: the confirm button's token routes through the exact
   * same `deps.confirm` a bare token typed on the terminal uses — one execution
   * path, one set of valid/expired/wrong-session-token behaviors, regardless of
   * how the token got here. A click the core accepted (the action ran, failed,
   * or the turn resumes) turns its card into the choice taken, before
   * anything else; one it didn't (`not-found`: expired, used, or someone
   * else's in a shared space) leaves the card for whoever has to choose.
   */
  const onCardClick: CardClickHandler =
    deps.onCardClick ??
    (async (params, space, sender, senderEmail, isDirectMessage = false, messageName, locale, timeZone) => {
      const token = params.token;
      if (!token) {
        log(`[chat] card click with no token parameter`);
        return;
      }
      const principal: Principal = {
        id: sender,
        provider: "google-chat",
        ...(senderEmail === undefined ? {} : { claims: { email: senderEmail } }),
      };
      const sessionKey = deriveSessionKey(space, sender);
      let reply: ConfirmReply | null;
      if (deps.resolveConfirmation) {
        const outcome = await deps.resolveConfirmation(token, sessionKey, principal, locale);
        const accepted = outcome.status === "ok" || outcome.status === "failed" || outcome.status === "resume";
        if (accepted && messageName !== undefined && params.summary !== undefined) {
          try {
            const t = await textsFor(principal, locale);
            await updateCardFn(messageName, buildChosenCard(params.summary, params.label, t), clientDeps);
            log(`[chat:${space}] [out] confirm card ${messageName} patched to the choice taken`);
          } catch (err) {
            log(`[chat:${space}] confirm card patch failed: ${String(err)}`);
          }
        }
        // On not-found nothing was taken, so `confirm` gives the reply as it
        // always did: the core's own message for someone it won't talk to,
        // which the outcome doesn't carry.
        if (outcome.status === "not-found") reply = await deps.confirm(token, sessionKey, principal, locale);
        else if (outcome.text === null) reply = null;
        else reply = outcome.status === "resume" ? { text: outcome.text, resume: true } : { text: outcome.text };
      } else {
        reply = await deps.confirm(token, sessionKey, principal, locale);
      }
      if (reply?.resume && activeHandleTurn) {
        await resumeTurn(activeHandleTurn, space, principal, isDirectMessage, locale, timeZone);
        return;
      }
      if (reply !== null) {
        log(`[chat:${space}] [out] ${reply.text}`);
        const sent = await sendMessageFn(space, reply.text, clientDeps);
        sentMessageNames.add(sent.name);
      }
    });
  let activeSubscription: PubSubSubscription | undefined;

  /**
   * Per-turn output sink — same responsibilities as the retired `ChatStreamer`,
   * rebuilt against the new client. `viewer` is the person the turn is for;
   * outside a direct message, what only they may see is sent to them alone.
   * `t` gives the cards' texts in their language. `signal` is the turn's
   * stop: once it aborted, a reasoning block cut short ends as "Stopped"
   * rather than "Failed". `turn` is the turn's id, on its Stop buttons.
   */
  function createSink(
    space: string,
    viewer: { user: string; isDirectMessage: boolean },
    t: Translate,
    signal: AbortSignal,
    turn: string,
  ): StopAwareSink {
    let chain: Promise<void> = Promise.resolve();

    function enqueue(fn: () => Promise<void>): void {
      chain = chain.then(async () => {
        try {
          await fn();
        } catch (err) {
          log(`[chat:${space}] send failed: ${String(err)}`);
        }
      });
    }
    function sendPlain(text: string): void {
      enqueue(async () => {
        log(`[chat:${space}] [out] ${text}`);
        const sent = await sendMessageFn(space, text, clientDeps);
        sentMessageNames.add(sent.name);
      });
    }

    // Keyed by toolCallId (or, for a capture-ping, the id its own caller
    // generated — see index.ts's captureIncrement/processToolCorrections):
    // lets onToolFinish patch the exact message onToolStart created for
    // that same call, rather than guessing the most recent one.
    const toolCards = new Map<string, { name: string; label: string; detail: string }>();

    // Keyed by the SDK's own reasoning-block id, exactly like toolCards —
    // a tool-calling turn can reason more than once (before a tool call,
    // again after seeing its result), each burst a fully independent card,
    // never a continuation of an earlier one.
    const reasoningCards = new Map<string, { name: string | undefined; buffer: string }>();

    // Claimed (patched into the turn's first reasoning card) by
    // onReasoningChunk below, then cleared — a second reasoning burst in
    // the same turn (e.g. after a tool call) always gets its own new card,
    // never reuses this one.
    let receivingCardName: string | undefined;

    // A tool asking again in the same turn hands back the same pending login.
    const shownLogins = new Set<string>();
    // Whether a card already says the person stopped the turn.
    let stopShown = false;
    // Set once the answer is on its way: a stop after it has nothing left to say.
    let answered = false;

    /** Patches the receiving card no reasoning claimed, to `state`: it has nothing else that would ever take its Stop button away. */
    async function closeReceivingCard(state: "answered" | "stopped"): Promise<boolean> {
      if (receivingCardName === undefined) return false;
      const name = receivingCardName;
      receivingCardName = undefined;
      log(`[chat:${space}] [out] receiving card ${name}: ${state}`);
      await updateCardFn(name, buildReceivingCard(t, turn, state), clientDeps);
      return true;
    }
    enqueue(async () => {
      log(`[chat:${space}] [out] receiving card`);
      const sent = await sendCardFn(space, buildReceivingCard(t, turn), clientDeps);
      sentMessageNames.add(sent.name);
      receivingCardName = sent.name;
    });

    return {
      onToolStart: (label: string, detail?: string, toolCallId?: string) => {
        if (toolCallId === undefined) {
          sendPlain(`_${label}_`);
          return;
        }
        enqueue(async () => {
          const card = buildToolCallCard(label, detail ?? "", "loading", t, turn);
          log(`[chat:${space}] [out] tool card: ${label}`);
          const sent = await sendCardFn(space, card, clientDeps);
          sentMessageNames.add(sent.name);
          toolCards.set(toolCallId, { name: sent.name, label, detail: detail ?? "" });
        });
      },
      onToolFinish: (toolCallId: string, outcome: ToolOutcome) => {
        enqueue(async () => {
          const entry = toolCards.get(toolCallId);
          if (!entry) {
            log(`[chat:${space}] onToolFinish for unknown toolCallId ${toolCallId}`);
            return;
          }
          const card = buildToolCallCard(entry.label, entry.detail, outcome, t, turn);
          log(`[chat:${space}] [out] patching ${entry.name} to "${outcome}"`);
          const patched = await updateCardFn(entry.name, card, clientDeps);
          log(`[chat:${space}] [out] patched ${patched.name}`);
          toolCards.delete(toolCallId);
        });
      },
      // Only ever fires for a model that actually supports Ollama's
      // extended thinking (see src/index.ts's OLLAMA_THINK) — a
      // non-reasoning model means this is simply never called, so no card
      // is ever created for that turn.
      onReasoningChunk: (chunk: string, id: string) => {
        let entry = reasoningCards.get(id);
        if (!entry) {
          entry = { name: undefined, buffer: chunk };
          reasoningCards.set(id, entry);
          enqueue(async () => {
            const card = buildToolCallCard(t("google-chat.thinking"), "", "loading", t, turn);
            if (receivingCardName !== undefined) {
              // Replace the "Status" placeholder in place instead of
              // sending a second message.
              log(`[chat:${space}] [out] reasoning card (${id}) — replacing receiving card`);
              const patched = await updateCardFn(receivingCardName, card, clientDeps);
              entry!.name = patched.name;
              receivingCardName = undefined;
            } else {
              log(`[chat:${space}] [out] reasoning card (${id})`);
              const sent = await sendCardFn(space, card, clientDeps);
              sentMessageNames.add(sent.name);
              entry!.name = sent.name;
            }
          });
          return;
        }
        // Accumulated only, never patched here: no live peek at the
        // reasoning text while it's still streaming — see buildToolCallCard's
        // doc comment for why. Revealed once, in full, by onReasoningEnd.
        entry.buffer += chunk;
      },
      onReasoningEnd: (id: string, failed: boolean) => {
        log(`[chat:${space}] onReasoningEnd(${id}, failed=${failed})`);
        const entry = reasoningCards.get(id);
        if (!entry) return; // no reasoning happened for this id — no card to close
        enqueue(async () => {
          if (entry.name === undefined) return; // shouldn't happen given enqueue's own FIFO ordering, but stays defensive
          const status = !failed ? "success" : signal.aborted ? "stopped" : "failed";
          if (status === "stopped") stopShown = true;
          const card = buildToolCallCard(t("google-chat.thinking"), tailTruncate(entry.buffer, REASONING_TAIL_CHARS), status, t, turn);
          log(`[chat:${space}] [out] reasoning patch (${id}): status=${status} bufferLen=${entry.buffer.length}`);
          await updateCardFn(entry.name, card, clientDeps);
          reasoningCards.delete(id);
        });
      },
      // Deliberately absent: Google Chat only shows a message once fully
      // sent, so incremental delivery never actually reaches a human
      // faster — this MUST stay undefined, it's what keeps runTurn on its
      // non-streaming path (see src/router/provider.ts's TurnSink).
      onUsage: (inputTokens) => log(`[chat:${space}] [usage] inputTokens=${inputTokens ?? "?"}`),
      onStep: (step) => {
        const pending = detectPendingConfirmation(step);
        if (pending) {
          enqueue(async () => {
            log(`[chat:${space}] [out] confirm card: ${pending.summary}`);
            const sent = await sendCardFn(space, buildConfirmCard(pending, t), clientDeps);
            sentMessageNames.add(sent.name);
          });
        }
        const login = detectLoginRequired(step);
        if (login && !shownLogins.has(login.url)) {
          shownLogins.add(login.url);
          enqueue(async () => {
            log(`[chat:${space}] [out] login card: ${login.service}`);
            const options = viewer.isDirectMessage ? undefined : { privateViewer: viewer.user };
            const sent = await sendCardFn(space, buildLoginCard(login, t), clientDeps, options);
            sentMessageNames.add(sent.name);
          });
        }
      },
      finalize: async (finalText, info) => {
        // The core's stand-in for an answer the model didn't write: the
        // confirmation card already says it; only a list after it is sent.
        const note = info?.pendingNote;
        const shown = note !== undefined && finalText.startsWith(note) ? finalText.slice(note.length) : finalText;
        const trimmed = shown.trim();
        answered = true;
        enqueue(async () => {
          await closeReceivingCard("answered");
        });
        if (trimmed.length > 0 && trimmed !== NO_REPLY) {
          for (const message of splitForSendLimit(trimmed)) {
            sendPlain(message);
          }
        }
        await chain;
      },
      dispose: () => {},
      settle: async (failed) => {
        if (answered) return;
        if (!signal.aborted) {
          if (!failed) return;
          enqueue(async () => {
            await closeReceivingCard("answered");
          });
          await chain;
          return;
        }
        enqueue(async () => {
          if (await closeReceivingCard("stopped")) stopShown = true;
          if (stopShown) return;
          stopShown = true;
          const text = statusLine("stopped", t);
          log(`[chat:${space}] [out] ${text}`);
          const sent = await sendMessageFn(space, text, clientDeps);
          sentMessageNames.add(sent.name);
        });
        await chain;
      },
    };
  }

  async function processMessageEvent(event: ParsedMessageEvent, handleTurn: HandleTurn): Promise<void> {
    if (sentMessageNames.has(event.messageName)) return;

    log(`[chat:${event.space}:${event.sender}] [in] ${event.text}`);

    const sessionKey = deriveSessionKey(event.space, event.sender);
    const markedInput = event.senderDisplayName ? `[Da: ${event.senderDisplayName}]\n${event.text}` : event.text;

    const principal: Principal = {
      id: event.sender,
      provider: "google-chat",
      ...(event.senderDisplayName ? { displayName: event.senderDisplayName } : {}),
      // A directory joins a Chat identity to a person on it (see the ZITADEL directory).
      ...(event.senderEmail === undefined ? {} : { claims: { email: event.senderEmail } }),
    };

    const reply = await deps.confirm(event.text, sessionKey, principal, event.locale);
    if (reply?.resume) {
      await resumeTurn(handleTurn, event.space, principal, event.isDirectMessage, event.locale, event.timeZone);
      return;
    }
    if (reply !== null) {
      log(`[chat:${event.space}] [out] ${reply.text}`);
      const sent = await sendMessageFn(event.space, reply.text, clientDeps);
      sentMessageNames.add(sent.name);
      return;
    }

    const t = await textsFor(principal, event.locale);
    // Only the actual model turn needs serializing — the confirmation above
    // never touches SessionHistory, so it's always safe to run right
    // away regardless of whether this session is mid-turn.
    await runInSession(sessionKey, (signal, turnId) =>
      runTurn(
        handleTurn,
        {
          channel: "google-chat",
          multiUser: !event.isDirectMessage,
          text: markedInput,
          sessionKey,
          principal,
          logPrefix: `[chat:${event.space}:${event.sender}] `,
          ...(event.locale === undefined ? {} : { languageHint: event.locale }),
          ...(event.timeZone === undefined ? {} : { timeZoneHint: event.timeZone }),
        },
        createSink(event.space, { user: event.sender, isDirectMessage: event.isDirectMessage }, t, signal, turnId),
        signal,
      ),
    );
  }

  /**
   * A stop from the person: aborts their running turn in this space and
   * discards what's queued behind it (`stopSession`), ahead of the queue it
   * would otherwise wait in. Only their own session: in a shared space,
   * someone else's stop finds nothing of theirs running. `/stop` with nothing
   * to stop says so; a click on a card whose turn is over does nothing.
   */
  async function processStopEvent(event: ParsedStopEvent): Promise<void> {
    const sessionKey = deriveSessionKey(event.space, event.sender);
    if (stopSession(sessionKey, event.turn)) {
      log(`[chat:${event.space}:${event.sender}] [in] stop (${event.source})`);
      return;
    }
    log(`[chat:${event.space}:${event.sender}] [in] stop (${event.source}), nothing running`);
    if (event.source !== "command") return;
    const principal: Principal = {
      id: event.sender,
      provider: "google-chat",
      ...(event.senderEmail === undefined ? {} : { claims: { email: event.senderEmail } }),
    };
    const t = await textsFor(principal, event.locale);
    const sent = await sendMessageFn(event.space, t("google-chat.stop.nothing"), clientDeps);
    sentMessageNames.add(sent.name);
  }

  /**
   * Acks each message immediately on arrival — before `handleTurn` (or
   * `onCardClick`) ever runs, not after it resolves. Same pattern the
   * open-source Hermes agent's Google Chat adapter uses (ack in the Pub/Sub
   * callback, agent processing dispatched separately): a real multi-step
   * turn routinely takes longer than the subscription's ack deadline
   * (Google's default is 10s), so acking only once processing completes
   * would leave a message open to being redelivered — and reprocessed a
   * second time, concurrently — while still being worked on. Acking first
   * decouples "message confirmed" from "turn finished" entirely, so no
   * turn duration can trigger a redelivery. Accepted tradeoff, same one
   * Hermes makes: a hard crash mid-turn loses that one message rather than
   * risking an endless redelivery loop.
   */
  async function handleMessage(message: StreamMessage, handleTurn: HandleTurn): Promise<void> {
    message.ack();
    let parsed: ParsedMessageEvent | ParsedCardClickEvent | ParsedStopEvent | null;
    try {
      parsed = parseChatEvent(JSON.parse(message.data.toString("utf-8")));
    } catch (err) {
      log(`[chat] failed to parse Pub/Sub message: ${String(err)}`);
      return;
    }
    if (!parsed) return;
    try {
      if (parsed.kind === "message") {
        await processMessageEvent(parsed, handleTurn);
      } else if (parsed.kind === "stop") {
        await processStopEvent(parsed);
      } else {
        await onCardClick(parsed.parameters, parsed.space, parsed.sender, parsed.senderEmail, parsed.isDirectMessage, parsed.messageName, parsed.locale, parsed.timeZone);
      }
    } catch (err) {
      log(`[chat] event handling failed: ${String(err)}`);
    }
  }

  return {
    async start(handleTurn: HandleTurn): Promise<void> {
      activeHandleTurn = handleTurn;
      const sub = subscriptionFn(deps.credentials, deps.subscription);
      activeSubscription = sub;
      sub.on("message", (message) => {
        handleMessage(message, handleTurn).catch((err) => log(`[chat] event handling failed: ${String(err)}`));
      });
      // The SDK retries transient stream errors internally — this only
      // fires for something it gave up on. Logged, not thrown: one bad
      // stream event must never take down the rest of Mercury (same
      // convention every other channel/poller loop in this project
      // follows).
      sub.on("error", (err) => log(`[chat] pubsub stream error: ${String(err)}`));
    },

    async stop(): Promise<void> {
      await activeSubscription?.close();
    },

    async notify(userId: string, text: string): Promise<{ sessionKey: string }> {
      // sessionKey is the DM space's name, not the sent message's — matches
      // the retired channel's exact behavior (preserved, not fixed, per
      // this plan's "known pre-existing inconsistency" note: a real
      // conversation in that DM is keyed space:sender, not space.name
      // alone; reconciling that is a separate decision).
      const space = await getOrCreateDmSpaceFn(userId, clientDeps);
      const sent = await sendMessageFn(space.name, text, clientDeps);
      sentMessageNames.add(sent.name); // loop prevention applies here too — a proactive notification is still our own message if it comes back as an event
      return { sessionKey: space.name };
    },
  };
}
