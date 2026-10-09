import { describe, expect, test } from "bun:test";
import {
  createGoogleChatProvider,
  deriveSessionKey,
  parseChatEvent,
  type GoogleChatProviderDeps,
} from "./google-chat-provider.ts";
import { PENDING_CONFIRMATION_NOTE, type HandleTurn, type InboundTurn, type TurnSink } from "@mercury-fw/channel-types";

const creds = { clientEmail: "bot@test.iam.gserviceaccount.com", privateKey: "fake" };

/** A fake `PubSubSubscription` — lets a test register the provider's real listeners, then trigger a "message"/"error" event directly, without any real gRPC. */
function fakeSubscription() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  let closed = false;
  return {
    on(event: string, cb: (...args: any[]) => void) {
      (listeners[event] ??= []).push(cb);
    },
    close: async () => {
      closed = true;
    },
    emit(event: string, ...args: any[]) {
      for (const cb of listeners[event] ?? []) cb(...args);
    },
    get isClosed() {
      return closed;
    },
  };
}

/** A fake incoming Pub/Sub message — `ack` records into the given array so tests can assert ack ordering/timing without a real `ackId` concept (the SDK acks per-message, not by id). */
function fakeMessage(data: unknown, acked: string[], ackId = "a1") {
  return {
    data: Buffer.from(JSON.stringify(data)),
    ack: () => acked.push(ackId),
    nack: () => {},
  };
}

function baseDeps(overrides: Partial<GoogleChatProviderDeps> = {}): GoogleChatProviderDeps {
  return {
    credentials: creds,
    subscription: "projects/p/subscriptions/s",
    // Default: input is never token-shaped, so every message falls through to
    // handleTurn. Confirmation tests override this with a stub that returns a
    // reply for a known token (the real tryConfirm is exercised in the core).
    confirm: async () => null,
    tokenSourceFn: () => ({ getToken: async () => "fake-token" }),
    sendMessageFn: async (_space, _text) => ({ name: "spaces/X/messages/sent" }),
    // Every turn now sends an immediate "Stato" card on start (see
    // createSink) — a safe default so tests that don't care about cards
    // specifically don't trigger a real HTTP call to the Chat API.
    sendCardFn: async (_space, _card) => ({ name: "spaces/X/messages/card-sent" }),
    subscriptionFn: () => fakeSubscription() as any, // default: a subscription no test drives, only used by tests not centered on message dispatch
    log: () => {},
    ...overrides,
  };
}

describe("deriveSessionKey", () => {
  test("composes space and sender", () => {
    expect(deriveSessionKey("spaces/X", "users/42")).toBe("spaces/X:users/42");
  });
});

describe("parseChatEvent", () => {
  test("parses a well-formed MESSAGE event", () => {
    const raw = {
      type: "MESSAGE",
      message: {
        name: "spaces/X/messages/1",
        text: "hello",
        space: { name: "spaces/X" },
        sender: { name: "users/42", displayName: "Luca", email: "luca@example.com" },
        thread: { name: "spaces/X/threads/T1" },
      },
    };
    expect(parseChatEvent(raw)).toEqual({
      kind: "message",
      text: "hello",
      messageName: "spaces/X/messages/1",
      space: "spaces/X",
      sender: "users/42",
      senderDisplayName: "Luca",
      senderEmail: "luca@example.com",
      isDirectMessage: false,
    });
  });

  // #190: the sender's email is what a directory joins a Chat identity on.
  // Google vouches for it only for a person; a bot's is left out.
  test("keeps the sender's email for a person only", () => {
    const event = (sender: object) => ({
      type: "MESSAGE",
      message: { name: "spaces/X/messages/1", text: "hi", space: { name: "spaces/X" }, sender: { name: "users/42", ...sender } },
    });
    expect(parseChatEvent(event({ email: "a@example.com", type: "HUMAN" }))).toMatchObject({ senderEmail: "a@example.com" });
    expect(parseChatEvent(event({ email: "a@example.com" }))).toMatchObject({ senderEmail: "a@example.com" });
    expect(parseChatEvent(event({ email: "bot@example.com", type: "BOT" }))).toMatchObject({ senderEmail: undefined });
    expect(parseChatEvent(event({ email: 3 }))).toMatchObject({ senderEmail: undefined });
  });

  test("returns null for a MESSAGE event missing a required field", () => {
    const raw = { type: "MESSAGE", message: { text: "hi", space: { name: "spaces/X" } } };
    expect(parseChatEvent(raw)).toBeNull();
  });

  // The multi-user NO_REPLY caution (index.ts's buildSystemPrompt) only
  // makes sense for a space Mercury shares with other people — a DM is
  // always 1:1 with Mercury, so every message there is unambiguously
  // addressed to it. Anything other than a confirmed "DM" (missing,
  // "ROOM", or an unrecognized value) stays on the cautious side.
  test("marks a DM space event as a direct message", () => {
    const raw = {
      type: "MESSAGE",
      message: {
        name: "spaces/X/messages/1",
        text: "ciao",
        space: { name: "spaces/X", type: "DM" },
        sender: { name: "users/42", displayName: "Luca" },
      },
    };
    expect(parseChatEvent(raw)).toMatchObject({ isDirectMessage: true });
  });

  test("does not mark a room/group space as a direct message", () => {
    const raw = {
      type: "MESSAGE",
      message: {
        name: "spaces/X/messages/1",
        text: "ciao",
        space: { name: "spaces/X", type: "ROOM" },
        sender: { name: "users/42", displayName: "Luca" },
      },
    };
    expect(parseChatEvent(raw)).toMatchObject({ isDirectMessage: false });
  });

  test("parses a well-formed CARD_CLICKED event", () => {
    const raw = {
      type: "CARD_CLICKED",
      space: { name: "spaces/X" },
      user: { name: "users/42", email: "luca@example.com", type: "HUMAN" },
      action: { parameters: [{ key: "token", value: "ABC123" }] },
    };
    expect(parseChatEvent(raw)).toEqual({
      kind: "card-click",
      space: "spaces/X",
      sender: "users/42",
      senderEmail: "luca@example.com",
      parameters: { token: "ABC123" },
    });
  });

  test("returns null for an unrecognized event type", () => {
    expect(parseChatEvent({ type: "ADDED_TO_SPACE" })).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(parseChatEvent(null)).toBeNull();
    expect(parseChatEvent("garbage")).toBeNull();
  });
});

function messageEvent(
  overrides: Partial<{ text: string; messageName: string; space: string; spaceType: string; sender: string; senderDisplayName: string; senderEmail: string; thread: string }> = {},
) {
  return {
    type: "MESSAGE",
    message: {
      name: overrides.messageName ?? "spaces/X/messages/1",
      text: overrides.text ?? "hello",
      space: { name: overrides.space ?? "spaces/X", type: overrides.spaceType },
      sender: {
        name: overrides.sender ?? "users/42",
        displayName: overrides.senderDisplayName ?? "Luca",
        email: overrides.senderEmail ?? "luca@example.com",
        type: "HUMAN",
      },
      thread: { name: overrides.thread ?? "spaces/X/threads/T1" },
    },
  };
}

describe("createGoogleChatProvider — notify", () => {
  test("notify resolves a DM space then sends, returning the space name as sessionKey", async () => {
    const calls: string[] = [];
    const deps = baseDeps({
      getOrCreateDmSpaceFn: async (userId) => {
        calls.push(`dm:${userId}`);
        return { name: "spaces/DM1" };
      },
      sendMessageFn: async (space, text) => {
        calls.push(`send:${space}:${text}`);
        return { name: "spaces/DM1/messages/1" };
      },
    });
    const provider = createGoogleChatProvider(deps);

    const result = await provider.notify("users/42", "ciao");

    expect(result).toEqual({ sessionKey: "spaces/DM1" });
    expect(calls).toEqual(["dm:users/42", "send:spaces/DM1:ciao"]);
  });
});

describe("createGoogleChatProvider — StreamingPull", () => {
  test("dispatches a MESSAGE event to handleTurn, with a sink that never defines onTextChunk", async () => {
    let capturedTurn: InboundTurn | undefined;
    let capturedSink: TurnSink | undefined;
    const acked: string[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    const handleTurn: HandleTurn = async (turn, sink) => {
      capturedTurn = turn;
      capturedSink = sink;
      await sink.finalize("risposta");
    };

    await provider.start(handleTurn);
    sub.emit("message", fakeMessage(messageEvent(), acked));
    // handleMessage is async, dispatched fire-and-forget from the "message"
    // listener — give its promise chain a tick to resolve.
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedTurn).toMatchObject({
      channel: "google-chat",
      multiUser: true,
      text: "[Da: Luca]\nhello",
      sessionKey: "spaces/X:users/42",
      principal: { id: "users/42", provider: "google-chat", displayName: "Luca", claims: { email: "luca@example.com" } },
    });
    expect(capturedSink!.onTextChunk).toBeUndefined();
    expect(acked).toEqual(["a1"]);
  });

  test("a sender without a display name gets a principal without one", async () => {
    let capturedTurn: InboundTurn | undefined;
    const sub = fakeSubscription();
    const provider = createGoogleChatProvider(baseDeps({ subscriptionFn: () => sub as any }));

    await provider.start(async (turn, sink) => {
      capturedTurn = turn;
      await sink.finalize("risposta");
    });
    sub.emit("message", fakeMessage(messageEvent({ senderDisplayName: "", senderEmail: "" }), []));
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedTurn?.principal).toEqual({ id: "users/42", provider: "google-chat" });
  });

  // Regression guard: a DM is always 1:1 with Mercury, so the multi-user
  // NO_REPLY caution must never apply there — a bare "ciao" in a DM was
  // observed live getting silently swallowed because multiUser was
  // hardcoded true for every Chat message regardless of space type.
  test("marks a DM message's turn as not multi-user", async () => {
    let capturedTurn: InboundTurn | undefined;
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (turn, sink) => {
      capturedTurn = turn;
      await sink.finalize("ciao");
    });
    sub.emit("message", fakeMessage(messageEvent({ spaceType: "DM" }), []));
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedTurn).toMatchObject({ multiUser: false });
  });

  test("omits the [Da: X] marker when the event has no sender displayName", async () => {
    let capturedTurn: InboundTurn | undefined;
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (turn, sink) => {
      capturedTurn = turn;
      await sink.finalize("ok");
    });
    sub.emit("message", fakeMessage({ ...messageEvent(), message: { ...messageEvent().message, sender: { name: "users/42" } } }, []));
    await new Promise((r) => setTimeout(r, 20));

    expect(capturedTurn?.text).toBe("hello");
  });

  test("a bare confirmation token message is intercepted (via deps.confirm) before handleTurn, and never reaches it", async () => {
    const token = "TOKEN-1234";
    let handleTurnCalled = false;
    const sent: string[] = [];
    const confirmArgs: unknown[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({
      confirm: async (t, sessionKey, principal) => {
        confirmArgs.push([t, sessionKey, principal]);
        return t === token ? 'Confermato ed eseguito: {"deleted":true}' : null;
      },
      subscriptionFn: () => sub as any,
      sendMessageFn: async (_space, text) => {
        sent.push(text);
        return { name: "spaces/X/messages/2" };
      },
    });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async () => {
      handleTurnCalled = true;
    });
    sub.emit("message", fakeMessage(messageEvent({ text: token }), []));
    await new Promise((r) => setTimeout(r, 20));

    expect(handleTurnCalled).toBe(false);
    expect(sent).toEqual(['Confermato ed eseguito: {"deleted":true}']);
    // The sender as the core keys people: only they can confirm what they staged.
    expect(confirmArgs).toEqual([
      [token, "spaces/X:users/42", { id: "users/42", provider: "google-chat", displayName: "Luca", claims: { email: "luca@example.com" } }],
    ]);
  });

  test("an event whose messageName was already sent by this provider is skipped (loop prevention)", async () => {
    let handleTurnCalled = false;
    const sub = fakeSubscription();

    const deps = baseDeps({
      subscriptionFn: () => sub as any,
      getOrCreateDmSpaceFn: async () => ({ name: "spaces/X" }),
      sendMessageFn: async () => ({ name: "spaces/X/messages/self" }),
    });
    const provider = createGoogleChatProvider(deps);

    // Send a message once so its name enters the loop-prevention set.
    await provider.notify("users/1", "noise"); // uses sendMessageFn, which always returns the same name here
    await provider.start(async () => {
      handleTurnCalled = true;
    });
    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/self" }), []));
    await new Promise((r) => setTimeout(r, 20));

    expect(handleTurnCalled).toBe(false);
  });

  test("dispatches a CARD_CLICKED event to the onCardClick handler, not to handleTurn", async () => {
    let cardClickArgs: unknown[] = [];
    let handleTurnCalled = false;
    const sub = fakeSubscription();

    const deps = baseDeps({
      subscriptionFn: () => sub as any,
      onCardClick: async (params, space, sender) => {
        cardClickArgs = [params, space, sender];
      },
    });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async () => {
      handleTurnCalled = true;
    });
    sub.emit(
      "message",
      fakeMessage(
        { type: "CARD_CLICKED", space: { name: "spaces/X" }, user: { name: "users/42" }, action: { parameters: [{ key: "token", value: "TOK" }] } },
        [],
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(handleTurnCalled).toBe(false);
    expect(cardClickArgs).toEqual([{ token: "TOK" }, "spaces/X", "users/42"]);
  });

  // The confirmation button's whole point: a click routes into the exact
  // same execution path a typed `conferma <token>` message does — no
  // separate logic to keep in sync, no new failure mode. Only exercised
  // when the caller doesn't override `onCardClick` (the default behavior).
  test("clicking the confirm button routes the token through deps.confirm and sends the reply", async () => {
    const token = "TOK-OK";
    const sent: string[] = [];
    const confirmArgs: unknown[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({
      confirm: async (t, sessionKey, principal) => {
        confirmArgs.push([t, sessionKey, principal]);
        return t === token ? 'Confermato ed eseguito: {"deleted":true}' : null;
      },
      subscriptionFn: () => sub as any,
      sendMessageFn: async (_space, text) => {
        sent.push(text);
        return { name: "spaces/X/messages/2" };
      },
    });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async () => {});
    sub.emit(
      "message",
      fakeMessage(
        {
          type: "CARD_CLICKED",
          space: { name: "spaces/X" },
          user: { name: "users/42", email: "luca@example.com", type: "HUMAN" },
          action: { parameters: [{ key: "token", value: token }] },
        },
        [],
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual(['Confermato ed eseguito: {"deleted":true}']);
    // The sender as the core keys people: only they can confirm what they staged.
    expect(confirmArgs).toEqual([[token, "spaces/X:users/42", { id: "users/42", provider: "google-chat", claims: { email: "luca@example.com" } }]]);
  });

  test("clicking the confirm button forwards deps.confirm's canned error for an unknown/expired token", async () => {
    // deps.confirm (the core's tryConfirm) returns the canned message for a
    // token-shaped-but-not-found token; the provider just forwards it.
    const sent: string[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({
      confirm: async () => "Nessuna conferma in sospeso per questo token — potrebbe essere scaduta, già usata, o mai esistita.",
      subscriptionFn: () => sub as any,
      sendMessageFn: async (_space, text) => {
        sent.push(text);
        return { name: "spaces/X/messages/2" };
      },
    });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async () => {});
    sub.emit(
      "message",
      fakeMessage(
        { type: "CARD_CLICKED", space: { name: "spaces/X" }, user: { name: "users/42" }, action: { parameters: [{ key: "token", value: "ABCD-EFGH" }] } },
        [],
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual(["Nessuna conferma in sospeso per questo token — potrebbe essere scaduta, già usata, o mai esistita."]);
  });

  // Regression test for the redelivery/duplicate-processing bug (fixed
  // pre-StreamingPull, still applies): a message must be acked before
  // handleTurn runs, not after it resolves — a real multi-step tool-calling
  // turn routinely takes longer than the subscription's ack deadline
  // (Google's default is 10s), so acking only once processing completes
  // would leave the message open to redelivery — and reprocessing — while
  // still being worked on. Same pattern the open-source Hermes agent's own
  // Google Chat adapter uses: ack in the Pub/Sub callback, before the
  // actual agent processing runs.
  test("acks a message before calling handleTurn, not after it resolves", async () => {
    const order: string[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (_turn, sink) => {
      order.push("handleTurn:start");
      await sink.finalize("risposta");
      order.push("handleTurn:end");
    });
    sub.emit("message", {
      data: Buffer.from(JSON.stringify(messageEvent())),
      ack: () => order.push("ack"),
      nack: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual(["ack", "handleTurn:start", "handleTurn:end"]);
  });

  // A turn that throws must not leave the message unacked — mirrors
  // Hermes' own tradeoff (ack first, process after): a crash mid-turn loses
  // that one message rather than risking it looping forever via redelivery.
  test("acks a message even when handleTurn throws", async () => {
    const acked: string[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async () => {
      throw new Error("boom");
    });
    sub.emit("message", fakeMessage(messageEvent(), acked));
    await new Promise((r) => setTimeout(r, 20));

    expect(acked).toEqual(["a1"]);
  });

  // Two messages arriving independently on the stream: each is acked and
  // dispatched on its own as soon as it arrives — no batching, unlike the
  // retired poll loop.
  test("acks two independently-arriving messages independently, not as one bundled call", async () => {
    const acked: string[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (_turn, sink) => {
      await sink.finalize("ok");
    });
    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/1" }), acked, "a1"));
    await new Promise((r) => setTimeout(r, 20));
    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/2" }), acked, "a2"));
    await new Promise((r) => setTimeout(r, 20));

    expect(acked).toEqual(["a1", "a2"]);
  });

  test("stop() closes the underlying subscription", async () => {
    const sub = fakeSubscription();
    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async () => {});
    expect(sub.isClosed).toBe(false);
    await provider.stop();

    expect(sub.isClosed).toBe(true);
  });

  // Since cli-tool.ts stopped dictating "reply `conferma <token>`" to the
  // model (channel-specific now), Google Chat's own confirmation UX is a
  // card with a button — not text the user has to type. The button's
  // parameters carry the token, so a click can be routed straight into
  // the same execution path as a typed token, without the user ever
  // seeing or handling the token themselves.
  test("a confirm-required step sends a card with the staged command and a token-carrying button, instead of plain text", async () => {
    const sentCards: Array<{ space: string; card: unknown }> = [];
    const sub = fakeSubscription();

    const deps = baseDeps({
      subscriptionFn: () => sub as any,
      sendCardFn: async (space, card) => {
        sentCards.push({ space, card });
        return { name: "spaces/X/messages/card1" };
      },
    });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (_turn, sink) => {
      sink.onStep?.({
        toolCalls: [{ toolCallId: "1", toolName: "runCommand", input: { command: "jira issue delete KAN-1 --confirm" } }],
        toolResults: [{ toolCallId: "1", toolName: "runCommand", output: { ok: false, pendingConfirmation: true, token: "TOK1", summary: "jira issue delete KAN-1 --confirm" } }],
        content: [],
      });
      await sink.finalize("Questa azione richiede conferma.");
    });
    sub.emit("message", fakeMessage(messageEvent(), []));
    await new Promise((r) => setTimeout(r, 20));

    // sentCards[0] is the turn's own immediate "Stato" card; the confirm card is the one after it.
    expect(sentCards).toHaveLength(2);
    const confirmCard = sentCards.find((c) => JSON.stringify(c.card).includes("TOK1"))!;
    expect(confirmCard.space).toBe("spaces/X");
    expect(JSON.stringify(confirmCard.card)).toContain("jira issue delete KAN-1 --confirm");
  });

  // agent-turn.ts returns PENDING_CONFIRMATION_NOTE as the turn's "text"
  // when the loop stopped for a pending confirmation (see
  // pendingConfirmationStop) — the card (test above) already says
  // everything a human needs. Sending this note too would be a second,
  // redundant message for the exact thing the card just covered.
  test("does not send PENDING_CONFIRMATION_NOTE as a message — the card already covers it", async () => {
    const sent: string[] = [];
    const sub = fakeSubscription();

    const deps = baseDeps({
      subscriptionFn: () => sub as any,
      sendMessageFn: async (_space, text) => {
        sent.push(text);
        return { name: "spaces/X/messages/1" };
      },
    });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (_turn, sink) => {
      await sink.finalize(PENDING_CONFIRMATION_NOTE);
    });
    sub.emit("message", fakeMessage(messageEvent(), []));
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual([]);
  });

  // Regression test: messages arrive on the stream independently of
  // whether a previous message's turn finished — two messages for the SAME
  // session arriving close together used to both call handleTurn
  // concurrently (back when delivery was a fixed-clock poll; the same race
  // is just as reachable with a stream, since nothing about StreamingPull
  // itself serializes handler invocations), both reading/writing the same
  // SessionHistory at once (observed live: confusing, stale-looking
  // replies mixing content from two different turns). A session must
  // finish its current turn before starting another one.
  test("serializes two messages for the same session arriving close together", async () => {
    const started: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (turn, sink) => {
      started.push(turn.text.split("\n").pop()!);
      if (turn.text.includes("first")) await firstGate;
      await sink.finalize("ok");
    });

    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/1", text: "first" }), [], "a1")); // starts "first", blocks on firstGate
    await new Promise((r) => setTimeout(r, 10));
    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/2", text: "second" }), [], "a2")); // arrives while "first" is still in flight, same session
    await new Promise((r) => setTimeout(r, 10));

    expect(started).toEqual(["first"]); // "second" must be queued, not started yet

    resolveFirst();
    await new Promise((r) => setTimeout(r, 10));

    expect(started).toEqual(["first", "second"]);
  });

  // The per-session lock must not become a global one — a slow turn for
  // one user/space must never hold up a different session's turn.
  test("does not block a different session's turn while one session is busy", async () => {
    const started: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (turn, sink) => {
      started.push(turn.text.split("\n").pop()!);
      if (turn.text.includes("first")) await firstGate;
      await sink.finalize("ok");
    });

    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/1", text: "first", sender: "users/1" }), [], "a1"));
    await new Promise((r) => setTimeout(r, 10));
    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/2", text: "second", sender: "users/2" }), [], "a2"));
    await new Promise((r) => setTimeout(r, 10));

    expect(started).toEqual(["first", "second"]);

    resolveFirst();
  });

  // A burst of more than two messages for the same busy session must all
  // queue and drain in the order they arrived, not just the first one.
  test("drains more than one queued message for the same session, in order", async () => {
    const started: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const sub = fakeSubscription();

    const deps = baseDeps({ subscriptionFn: () => sub as any });
    const provider = createGoogleChatProvider(deps);

    await provider.start(async (turn, sink) => {
      started.push(turn.text.split("\n").pop()!);
      if (turn.text.includes("first")) await firstGate;
      await sink.finalize("ok");
    });

    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/1", text: "first" }), [], "a1"));
    await new Promise((r) => setTimeout(r, 10));
    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/2", text: "second" }), [], "a2"));
    await new Promise((r) => setTimeout(r, 10));
    sub.emit("message", fakeMessage(messageEvent({ messageName: "spaces/X/messages/3", text: "third" }), [], "a3"));
    await new Promise((r) => setTimeout(r, 10));

    expect(started).toEqual(["first"]);

    resolveFirst();
    await new Promise((r) => setTimeout(r, 10));

    expect(started).toEqual(["first", "second", "third"]);
  });
});

describe("createSink — tool-call cards", () => {
  /** Dispatches one MESSAGE event and captures the sink handleTurn receives, without finalizing the turn (so tests can drive onToolStart/onToolFinish on it directly, exactly as turn-runner.ts would mid-turn). */
  async function captureSink(overrides: Partial<GoogleChatProviderDeps> = {}): Promise<TurnSink> {
    let capturedSink: TurnSink | undefined;
    const sub = fakeSubscription();
    const provider = createGoogleChatProvider(baseDeps({ subscriptionFn: () => sub as any, ...overrides }));

    await provider.start(async (_turn, sink) => {
      capturedSink = sink;
    });
    sub.emit("message", fakeMessage(messageEvent(), []));
    await new Promise((r) => setTimeout(r, 20));

    return capturedSink!;
  }

  test("onToolStart with a toolCallId sends a loading card via sendCardFn, not sendMessageFn", async () => {
    const sentCards: Array<{ space: string; card: any }> = [];
    const sentMessages: string[] = [];
    const sink = await captureSink({
      sendCardFn: async (space, card) => {
        sentCards.push({ space, card });
        return { name: "spaces/X/messages/card1" };
      },
      sendMessageFn: async (_space, text) => {
        sentMessages.push(text);
        return { name: "spaces/X/messages/plain1" };
      },
    });

    sink.onToolStart("Sto leggendo dati con jira…", "`jira issue search --jql X`", "tc-1");
    await new Promise((r) => setTimeout(r, 10));

    expect(sentMessages).toEqual([]);
    // sentCards[0] is the "Stato" card every turn sends immediately
    // on start (see createSink); the tool card is the one after it.
    expect(sentCards).toHaveLength(2);
    const toolCard = sentCards.find((c) => c.card.sections[0].header === "Sto leggendo dati con jira…")!;
    expect(toolCard.space).toBe("spaces/X");
    const section = toolCard.card.sections[0];
    expect(section.collapsible).toBe(true);
    expect(section.uncollapsibleWidgetsCount).toBe(0);
    expect(JSON.stringify(section.widgets)).toContain("jira issue search --jql X");
    expect(JSON.stringify(section.widgets)).toContain("In corso…");
  });

  test("onToolStart with no toolCallId still sends plain text via sendMessageFn (capture-ping path unchanged)", async () => {
    const sentCards: unknown[] = [];
    const sentMessages: string[] = [];
    const sink = await captureSink({
      sendCardFn: async (_space, card) => {
        sentCards.push(card);
        return { name: "spaces/X/messages/card1" };
      },
      sendMessageFn: async (_space, text) => {
        sentMessages.push(text);
        return { name: "spaces/X/messages/plain1" };
      },
    });

    sink.onToolStart("Mi sto segnando un'informazione importante…");
    await new Promise((r) => setTimeout(r, 10));

    expect(sentMessages).toEqual(["_Mi sto segnando un'informazione importante…_"]);
    // Only the turn's own immediate "Stato" card — no tool card, since a
    // capture-ping has no toolCallId.
    expect(sentCards).toHaveLength(1);
    expect((sentCards[0] as any).sections[0].header).toBe("Stato");
  });

  test("onToolFinish patches the exact message name onToolStart created, with the outcome's status line", async () => {
    const patched: Array<{ name: string; card: any }> = [];
    const sink = await captureSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/card1" }),
      updateCardFn: async (name, card) => {
        patched.push({ name, card });
        return { name };
      },
    });

    sink.onToolStart("Sto leggendo dati con jira…", "`jira issue search --jql X`", "tc-1");
    await new Promise((r) => setTimeout(r, 10));
    sink.onToolFinish?.("tc-1", "success");
    await new Promise((r) => setTimeout(r, 10));

    expect(patched).toHaveLength(1);
    expect(patched[0]!.name).toBe("spaces/X/messages/card1");
    const section = patched[0]!.card.sections[0];
    // The title itself must also reflect completion, not just the collapsed
    // body — a card whose header still reads "Sto leggendo..." forever
    // (present progressive) looked stuck-in-progress even once patched.
    expect(section.header).toBe("Sto leggendo dati con jira… Fatto.");
    expect(JSON.stringify(section.widgets)).toContain("Fatto.");
  });

  test.each([
    ["failed", "Non riuscito."],
    ["pending", "In attesa di conferma."],
  ] as const)("onToolFinish for '%s' renders the corresponding status line in both the title and the body", async (outcome, statusText) => {
    const patched: Array<{ card: any }> = [];
    const sink = await captureSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/card1" }),
      updateCardFn: async (name, card) => {
        patched.push({ card });
        return { name };
      },
    });

    sink.onToolStart("Sto scrivendo dati con jira…", "`jira issue delete KAN-1`", "tc-1");
    await new Promise((r) => setTimeout(r, 10));
    sink.onToolFinish?.("tc-1", outcome);
    await new Promise((r) => setTimeout(r, 10));

    expect(patched[0]!.card.sections[0].header).toBe(`Sto scrivendo dati con jira… ${statusText}`);
    expect(JSON.stringify(patched[0]!.card.sections[0].widgets)).toContain(statusText);
  });

  test("onToolFinish for an unknown toolCallId doesn't call updateCardFn", async () => {
    let updateCardCalled = false;
    const sink = await captureSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/card1" }),
      updateCardFn: async (name, card) => {
        updateCardCalled = true;
        return { name };
      },
    });

    sink.onToolFinish?.("unknown-tc", "success");
    await new Promise((r) => setTimeout(r, 10));

    expect(updateCardCalled).toBe(false);
  });

  test("two sequential tool calls in the same turn each get their own card (independent message names)", async () => {
    const sent: Array<{ card: any }> = [];
    const patched: Array<{ name: string; card: any }> = [];
    let cardCount = 0;
    const sink = await captureSink({
      sendCardFn: async (_space, card) => {
        cardCount++;
        sent.push({ card });
        return { name: `spaces/X/messages/card${cardCount}` };
      },
      updateCardFn: async (name, card) => {
        patched.push({ name, card });
        return { name };
      },
    });

    sink.onToolStart("Sto leggendo dati con jira…", "`jira issue search --jql X`", "tc-1");
    await new Promise((r) => setTimeout(r, 10));
    sink.onToolFinish?.("tc-1", "success");
    await new Promise((r) => setTimeout(r, 10));
    sink.onToolStart("Sto scrivendo sul wiki…", '`{"path":"x"}`', "tc-2");
    await new Promise((r) => setTimeout(r, 10));
    sink.onToolFinish?.("tc-2", "success");
    await new Promise((r) => setTimeout(r, 10));

    // 3 sends: the turn's own immediate "Stato" card, plus one per tool call.
    expect(sent).toHaveLength(3);
    expect(patched).toHaveLength(2);
    expect(patched[0]!.name).not.toBe(patched[1]!.name);
  });
});

describe("createSink — immediate receiving card", () => {
  async function captureSink(overrides: Partial<GoogleChatProviderDeps> = {}): Promise<TurnSink> {
    let capturedSink: TurnSink | undefined;
    const sub = fakeSubscription();
    const provider = createGoogleChatProvider(baseDeps({ subscriptionFn: () => sub as any, ...overrides }));

    await provider.start(async (_turn, sink) => {
      capturedSink = sink;
    });
    sub.emit("message", fakeMessage(messageEvent(), []));
    await new Promise((r) => setTimeout(r, 20));

    return capturedSink!;
  }

  // Covers the real gap (confirmed live, ~10s) between a message arriving
  // and the first visible activity — Ollama's own prompt-prefill/model-load
  // time, which happens before even the first reasoning token.
  test("a non-expandable 'Stato' card ('Messaggio in ricezione…') is sent immediately when the turn starts, before any tool/reasoning activity", async () => {
    const sentCards: any[] = [];
    await captureSink({
      sendCardFn: async (space, card) => {
        sentCards.push({ space, card });
        return { name: "spaces/X/messages/r1" };
      },
    });

    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]!.space).toBe("spaces/X");
    const section = sentCards[0]!.card.sections[0];
    // Generic "Stato" title, not a restatement of the body — leaves room
    // for a genuinely different state to reuse this same card shape later.
    expect(section.header).toBe("Stato");
    // A section with zero widgets rendered as a near-empty grey sliver in
    // Google Chat (confirmed live) — must always carry visible text.
    expect(section.widgets).not.toEqual([]);
    expect(JSON.stringify(section.widgets)).toContain("Messaggio in ricezione…");
    expect(section.collapsible).toBeUndefined(); // nothing to expand
  });

  test("if no reasoning ever happens, the receiving card is simply left as-is — a tool call gets its own separate card, never patches the receiving one", async () => {
    let cardCount = 0;
    const patchedNames: string[] = [];
    const sink = await captureSink({
      sendCardFn: async () => ({ name: `spaces/X/messages/card${cardCount++}` }),
      updateCardFn: async (name, card) => {
        patchedNames.push(name);
        return { name };
      },
    });
    // card0 = the receiving card, already sent by the time captureSink returns.

    sink.onToolStart("Sto leggendo dati con jira…", "jira issue search", "tc-1"); // sends card1
    await new Promise((r) => setTimeout(r, 10));
    sink.onToolFinish?.("tc-1", "success");
    await new Promise((r) => setTimeout(r, 10));

    // onReasoningChunk never ran, so the claim path never fires: onToolFinish
    // patches card1 (its own card), never card0 (the receiving card).
    expect(patchedNames).toEqual(["spaces/X/messages/card1"]);
  });
});

describe("createSink — reasoning card", () => {
  async function captureReasoningSink(overrides: Partial<GoogleChatProviderDeps> = {}): Promise<TurnSink> {
    let capturedSink: TurnSink | undefined;
    const sub = fakeSubscription();
    const provider = createGoogleChatProvider(baseDeps({ subscriptionFn: () => sub as any, ...overrides }));

    await provider.start(async (_turn, sink) => {
      capturedSink = sink;
    });
    sub.emit("message", fakeMessage(messageEvent(), []));
    await new Promise((r) => setTimeout(r, 20));

    return capturedSink!;
  }

  test("no card is sent when onReasoningChunk never fires — only the turn's own immediate receiving card", async () => {
    const sentCards: any[] = [];
    const sink = await captureReasoningSink({
      sendCardFn: async (_space, card) => {
        sentCards.push(card);
        return { name: "spaces/X/messages/r1" };
      },
    });

    sink.onReasoningEnd?.("block-1", false);
    await new Promise((r) => setTimeout(r, 20));

    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]!.sections[0].header).toBe("Stato");
  });

  // No live peek: the reasoning text itself must never appear before the
  // turn's own reasoning burst is done — only a static "in progress"
  // indicator, so there's nothing here for a user to expand mid-stream
  // (native `collapsible` resets on every PATCH; not patching at all while
  // loading is what actually fixes that, not forcing the card open).
  //
  // The first chunk claims the turn's own immediate "Stato" card
  // (see buildReceivingCard) by PATCHING it into this loading state,
  // rather than sending a second message — so this is a patch, not a send.
  test("the first onReasoningChunk patches the receiving card into a loading 'Sto pensando…' card with no reasoning content", async () => {
    const patched: Array<{ name: string; card: any }> = [];
    const sink = await captureReasoningSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/r1" }),
      updateCardFn: async (name, card) => {
        patched.push({ name, card });
        return { name };
      },
    });

    sink.onReasoningChunk?.("primo pezzo", "block-1");
    await new Promise((r) => setTimeout(r, 20));

    expect(patched).toHaveLength(1);
    expect(patched[0]!.name).toBe("spaces/X/messages/r1"); // the receiving card's own message
    const section = patched[0]!.card.sections[0];
    expect(section.header).toBe("Sto pensando…");
    expect(section.collapsible).toBe(true);
    expect(section.uncollapsibleWidgetsCount).toBe(0);
    expect(JSON.stringify(section.widgets)).toContain("In corso…");
    expect(JSON.stringify(section.widgets)).not.toContain("primo pezzo");
  });

  test("further chunks accumulate silently — no additional patch beyond the first chunk's claim", async () => {
    const patched: unknown[] = [];
    const sink = await captureReasoningSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/r1" }),
      updateCardFn: async (name, card) => {
        patched.push(card);
        return { name };
      },
    });

    sink.onReasoningChunk?.("uno ", "block-1"); // claims the receiving card — one patch
    await new Promise((r) => setTimeout(r, 20));
    expect(patched).toHaveLength(1);

    sink.onReasoningChunk?.("due ", "block-1");
    sink.onReasoningChunk?.("tre ", "block-1");
    await new Promise((r) => setTimeout(r, 20));

    expect(patched).toHaveLength(1); // still just the one claim patch — no live peek
  });

  test("onReasoningEnd sends the final patch, revealing everything accumulated, with success status", async () => {
    const patched: Array<{ card: any }> = [];
    const sink = await captureReasoningSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/r1" }),
      updateCardFn: async (name, card) => {
        patched.push({ card });
        return { name };
      },
    });

    sink.onReasoningChunk?.("ragionamento completo", "block-1");
    sink.onReasoningEnd?.("block-1", false);
    await new Promise((r) => setTimeout(r, 20));

    // patched[0] is the first chunk's claim (loading); patched[1] is the final reveal.
    expect(patched).toHaveLength(2);
    const section = patched[1]!.card.sections[0];
    expect(section.header).toBe("Sto pensando… Fatto.");
    // Native collapsible, collapsed by default — this is the LAST patch
    // this message will ever receive, so nothing can reset it out from
    // under the user again.
    expect(section.collapsible).toBe(true);
    expect(section.uncollapsibleWidgetsCount).toBe(0);
    expect(JSON.stringify(section.widgets)).toContain("ragionamento completo");
  });

  test("onReasoningEnd(id, true) patches that card to the failed status", async () => {
    const patched: Array<{ card: any }> = [];
    const sink = await captureReasoningSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/r1" }),
      updateCardFn: async (name, card) => {
        patched.push({ card });
        return { name };
      },
    });

    sink.onReasoningChunk?.("qualcosa", "block-1");
    sink.onReasoningEnd?.("block-1", true);
    await new Promise((r) => setTimeout(r, 20));

    expect(patched).toHaveLength(2);
    expect(patched[1]!.card.sections[0].header).toBe("Sto pensando… Non riuscito.");
  });

  test("tail-truncation shows the buffer's actual end, prefixed with '…', not its start", async () => {
    const patched: Array<{ card: any }> = [];
    const sink = await captureReasoningSink({
      sendCardFn: async () => ({ name: "spaces/X/messages/r1" }),
      updateCardFn: async (name, card) => {
        patched.push({ card });
        return { name };
      },
    });

    const longText = "a".repeat(3990) + "TAIL-MARKER";
    sink.onReasoningChunk?.(longText, "block-1");
    sink.onReasoningEnd?.("block-1", false);
    await new Promise((r) => setTimeout(r, 20));

    const body = JSON.stringify(patched[1]!.card.sections[0].widgets);
    expect(body).toContain("TAIL-MARKER");
    expect(body).toContain("…");
    expect(body).not.toContain("a".repeat(4000)); // the untruncated head is gone
  });

  // The user's reported scenario: reasoning, a tool call, then reasoning
  // again — two SDK ids, not a continuation of the first card. Each must
  // get its own independent card: block-1 claims the turn's own immediate
  // "Stato" card (patched, never a fresh send), block-2 arrives
  // after that card is already claimed, so it gets a genuinely new one.
  test("a second reasoning block (different id) after a tool call gets its own independent card", async () => {
    const sent: Array<{ card: any }> = [];
    const patched: Array<{ name: string; card: any }> = [];
    let cardCount = 0;
    const sink = await captureReasoningSink({
      sendCardFn: async (_space, card) => {
        cardCount++;
        sent.push({ card });
        return { name: `spaces/X/messages/r${cardCount}` };
      },
      updateCardFn: async (name, card) => {
        patched.push({ name, card });
        return { name };
      },
    });

    sink.onReasoningChunk?.("primo pensiero", "block-1");
    sink.onReasoningEnd?.("block-1", false);
    sink.onToolStart("Sto leggendo dati con jira…", "jira issue search", "tc-1");
    sink.onToolFinish?.("tc-1", "success");
    sink.onReasoningChunk?.("secondo pensiero", "block-2");
    sink.onReasoningEnd?.("block-2", false);
    await new Promise((r) => setTimeout(r, 20));

    const block1Reveal = patched.find((p) => JSON.stringify(p.card).includes("primo pensiero"))!;
    const block2Reveal = patched.find((p) => JSON.stringify(p.card).includes("secondo pensiero"))!;
    expect(block1Reveal).toBeDefined();
    expect(block2Reveal).toBeDefined();
    expect(block1Reveal.name).not.toBe(block2Reveal.name); // independent messages

    // block-2 got a genuinely new card (the receiving card was already
    // claimed by block-1), not a reused/patched one.
    const block2Send = sent.find((s) => (s.card.sections[0].header as string) === "Sto pensando…");
    expect(block2Send).toBeDefined();
  });

  test("reasoning calls interleaved with tool-call cards stay correctly ordered on the shared chain", async () => {
    const events: string[] = [];
    let cardCount = 0;
    const sink = await captureReasoningSink({
      sendCardFn: async (_space, card) => {
        cardCount++;
        const label = card.sections[0]!.header as string;
        events.push(`send:${label}`);
        return { name: `spaces/X/messages/c${cardCount}` };
      },
      updateCardFn: async (name, card) => {
        const label = card.sections[0]!.header as string;
        events.push(`patch:${label}`);
        return { name };
      },
    });

    sink.onReasoningChunk?.("pensando", "block-1");
    sink.onToolStart("Sto leggendo dati con jira…", "jira issue search", "tc-1");
    sink.onReasoningEnd?.("block-1", false);
    sink.onToolFinish?.("tc-1", "success");
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toEqual([
      "send:Stato", // the turn's own immediate card, sent before any of the above
      "patch:Sto pensando…", // block-1's first chunk claims it
      "send:Sto leggendo dati con jira…",
      "patch:Sto pensando… Fatto.",
      "patch:Sto leggendo dati con jira… Fatto.",
    ]);
  });
});
