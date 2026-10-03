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
} from "./google-chat-app-client.ts";
import { openSubscription, type PubSubSubscription, type StreamMessage } from "./google-chat-pubsub-stream.ts";
import { splitForSendLimit } from "./google-chat-message-buffer.ts";
import {
  detectPendingConfirmation,
  PENDING_CONFIRMATION_NOTE,
  NO_REPLY,
  type PendingConfirmation,
  type ToolOutcome,
  type Provider,
  type HandleTurn,
  type TurnSink,
} from "@mercury-fw/channel-types";

/**
 * Builds the confirmation card sent when a step stages an irreversible
 * command (see `pending-confirmation.ts`). The button's parameters carry
 * the token, so a click routes straight into the same `tryConfirm` path
 * a bare token typed on the terminal uses (see `onCardClick`'s `confirm`
 * case, below) — the user never has to see or type the token themselves.
 */
function buildConfirmCard(pending: PendingConfirmation): ChatCard {
  return {
    header: { title: "Conferma richiesta" },
    sections: [
      {
        widgets: [
          { textParagraph: { text: `\`${pending.summary}\`` } },
          {
            buttonList: {
              buttons: [
                {
                  text: "Conferma",
                  onClick: { action: { function: "confirm", parameters: [{ key: "token", value: pending.token }] } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const TOOL_STATUS_LINES: Record<"loading" | ToolOutcome, string> = {
  loading: "In corso…",
  success: "Fatto.",
  failed: "Non riuscito.",
  pending: "In attesa di conferma.",
};

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
 * collapsed body: a title stuck reading "Sto leggendo dati con jira…"
 * (present progressive) forever, even once the card's own body says
 * "Fatto.", looked like the card never updated at all — confirmed live
 * (the body did patch, only the title didn't change).
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
function buildToolCallCard(label: string, detail: string, status: "loading" | ToolOutcome): ChatCard {
  return {
    sections: [
      {
        header: status === "loading" ? label : `${label} ${TOOL_STATUS_LINES[status]}`,
        collapsible: true,
        uncollapsibleWidgetsCount: 0,
        widgets: [{ textParagraph: { text: detail } }, { textParagraph: { text: TOOL_STATUS_LINES[status] } }],
      },
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
 * Header is the generic "Stato" (not a restatement of the body) so this
 * has somewhere to grow if a genuinely different state ever becomes
 * observable, rather than needing a redesign.
 *
 * Not expandable (no `collapsible`) — there's nothing to fold away. A
 * section with zero widgets renders as a near-empty sliver in Google Chat
 * (confirmed live — a thin grey line, no visible text at all), so this
 * always carries at least one `textParagraph`, same as every other card
 * in this file. If the turn's first reasoning burst arrives,
 * `onReasoningChunk` patches this exact card into the "Sto pensando…"
 * card in place, rather than sending a second message; otherwise it's
 * simply left as the last status before the turn's real answer.
 */
function buildReceivingCard(): ChatCard {
  return { sections: [{ header: "Stato", widgets: [{ textParagraph: { text: "Messaggio in ricezione…" } }] }] };
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
    space?: { name?: string; type?: string };
    sender?: RawChatSender;
  };
  action?: { actionMethodName?: string; parameters?: Array<{ key?: string; value?: string }> };
  space?: { name?: string };
  user?: RawChatSender;
};

export type ParsedMessageEvent = {
  kind: "message";
  text: string;
  messageName: string;
  space: string;
  sender: string;
  senderDisplayName: string | undefined;
  /**
   * True only when `space.type` is exactly `"DM"` (the Chat API's shape
   * for a private 1:1 space) — anything else, including a missing field,
   * stays `false` on purpose: a DM is unambiguously addressed to Mercury,
   * everything else keeps the cautious multi-user default. Confirmed
   * live against a real DM event this session.
   */
  isDirectMessage: boolean;
};

export type ParsedCardClickEvent = {
  kind: "card-click";
  space: string;
  sender: string;
  parameters: Record<string, string>;
};

/** Parses one decoded Pub/Sub event, or `null` if it isn't a kind this provider acts on. */
export function parseChatEvent(raw: unknown): ParsedMessageEvent | ParsedCardClickEvent | null {
  const event = raw as RawChatEvent;
  if (event?.type === "MESSAGE") {
    const m = event.message;
    if (!m || typeof m.name !== "string" || typeof m.text !== "string") return null;
    if (typeof m.space?.name !== "string") return null;
    if (typeof m.sender?.name !== "string") return null;
    return {
      kind: "message",
      text: m.text,
      messageName: m.name,
      space: m.space.name,
      sender: m.sender.name,
      senderDisplayName: m.sender.displayName,
      isDirectMessage: m.space.type === "DM",
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
    return { kind: "card-click", space: event.space.name, sender: event.user.name, parameters };
  }
  return null;
}

export type CardClickHandler = (params: Record<string, string>, space: string, sender: string) => Promise<void>;

export type GoogleChatProviderDeps = {
  credentials: ServiceAccountCredentials;
  subscription: string;
  /**
   * Resolves a confirmation token against the core's shared store, injected by
   * the channel loader (`ChannelRuntimeContext.confirm`). Returns the reply to
   * send, or `null` when the input wasn't token-shaped. This is the whole of
   * the channel's contact with confirmation — the store, vault and note-writer
   * stay in the core.
   */
  confirm: (token: string, sessionKey: string, userId: string) => Promise<string | null>;
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
  // Per-session serialization: pollOnce's setInterval fires on a fixed
  // clock regardless of whether the previous tick's turn finished, so two
  // overlapping ticks could otherwise both call handleTurn for the SAME
  // session at once — both reading/writing the same SessionHistory
  // concurrently. Scoped by sessionKey only (not global), so a slow turn
  // for one user/space never blocks a different one's.
  const busySessions = new Set<string>();
  const queuedEvents = new Map<string, ParsedMessageEvent[]>();

  /**
   * Default `onCardClick`: the confirm button's token routes through the exact
   * same `deps.confirm` a bare token typed on the terminal uses — one execution
   * path, one set of valid/expired/wrong-session-token behaviors, regardless of
   * how the token got here.
   */
  const onCardClick: CardClickHandler =
    deps.onCardClick ??
    (async (params, space, sender) => {
      const token = params.token;
      if (!token) {
        log(`[chat] card click with no token parameter`);
        return;
      }
      const reply = await deps.confirm(token, deriveSessionKey(space, sender), sender);
      if (reply !== null) {
        log(`[chat:${space}] [out] ${reply}`);
        const sent = await sendMessageFn(space, reply, clientDeps);
        sentMessageNames.add(sent.name);
      }
    });
  let activeSubscription: PubSubSubscription | undefined;

  /** Per-turn output sink — same responsibilities as the retired `ChatStreamer`, rebuilt against the new client. */
  function createSink(space: string): TurnSink {
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
    enqueue(async () => {
      log(`[chat:${space}] [out] receiving card`);
      const sent = await sendCardFn(space, buildReceivingCard(), clientDeps);
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
          const card = buildToolCallCard(label, detail ?? "", "loading");
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
          const card = buildToolCallCard(entry.label, entry.detail, outcome);
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
            const card = buildToolCallCard("Sto pensando…", "", "loading");
            if (receivingCardName !== undefined) {
              // Replace the "Stato" placeholder in place instead of
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
          const status = failed ? "failed" : "success";
          const card = buildToolCallCard("Sto pensando…", tailTruncate(entry.buffer, REASONING_TAIL_CHARS), status);
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
            const sent = await sendCardFn(space, buildConfirmCard(pending), clientDeps);
            sentMessageNames.add(sent.name);
          });
        }
      },
      finalize: async (finalText: string) => {
        const trimmed = finalText.trim();
        if (trimmed.length > 0 && trimmed !== NO_REPLY && trimmed !== PENDING_CONFIRMATION_NOTE) {
          for (const message of splitForSendLimit(trimmed)) {
            sendPlain(message);
          }
        }
        await chain;
      },
      dispose: () => {},
    };
  }

  async function processMessageEvent(event: ParsedMessageEvent, handleTurn: HandleTurn): Promise<void> {
    if (sentMessageNames.has(event.messageName)) return;

    log(`[chat:${event.space}:${event.sender}] [in] ${event.text}`);

    const sessionKey = deriveSessionKey(event.space, event.sender);
    const markedInput = event.senderDisplayName ? `[Da: ${event.senderDisplayName}]\n${event.text}` : event.text;

    const confirmReply = await deps.confirm(event.text, sessionKey, event.sender);
    if (confirmReply !== null) {
      log(`[chat:${event.space}] [out] ${confirmReply}`);
      const sent = await sendMessageFn(event.space, confirmReply, clientDeps);
      sentMessageNames.add(sent.name);
      return;
    }

    // Only the actual model turn needs serializing — tryConfirm above
    // never touches SessionHistory, so it's always safe to run right
    // away regardless of whether this session is mid-turn.
    if (busySessions.has(sessionKey)) {
      const queue = queuedEvents.get(sessionKey) ?? [];
      queue.push(event);
      queuedEvents.set(sessionKey, queue);
      return;
    }

    busySessions.add(sessionKey);
    try {
      const sink = createSink(event.space);
      await handleTurn(
        {
          channel: "google-chat",
          multiUser: !event.isDirectMessage,
          text: markedInput,
          sessionKey,
          principal: {
            id: event.sender,
            provider: "google-chat",
            ...(event.senderDisplayName ? { displayName: event.senderDisplayName } : {}),
          },
          logPrefix: `[chat:${event.space}:${event.sender}] `,
        },
        sink,
      );
    } finally {
      busySessions.delete(sessionKey);
      const queue = queuedEvents.get(sessionKey);
      const next = queue?.shift();
      if (queue && queue.length === 0) queuedEvents.delete(sessionKey);
      if (next) {
        processMessageEvent(next, handleTurn).catch((err) => log(`[chat] queued event handling failed: ${String(err)}`));
      }
    }
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
    let parsed: ParsedMessageEvent | ParsedCardClickEvent | null;
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
      } else {
        await onCardClick(parsed.parameters, parsed.space, parsed.sender);
      }
    } catch (err) {
      log(`[chat] event handling failed: ${String(err)}`);
    }
  }

  return {
    async start(handleTurn: HandleTurn): Promise<void> {
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
