import { describe, expect, test } from "bun:test";
import { createTurnRunner, type PostTurnGuard } from "./turn-runner.ts";
import type { InboundTurn, TurnSink } from "./provider.ts";
import type { Principal } from "@mercury-fw/channel-types";
import { createSessionHistory, type SessionHistory } from "../session/history.ts";
import { createSessionLock } from "./session-lock.ts";
import type { StepInfo } from "../session/step-info.ts";

function fakeHistory(overrides: Partial<SessionHistory> = {}): SessionHistory {
  return {
    addUserMessage: async () => {},
    addAssistantMessage: async () => {},
    replaceLastAssistantMessage: () => {},
    getMessages: () => [],
    getCharCount: () => 0,
    ...overrides,
  };
}

/** A principal a provider vouched for: the turn is tracked for capture. */
function verified(id: string): Principal {
  return { id, provider: "google-chat" };
}

/** A principal nobody vouched for (terminal, unauthenticated HTTP): the turn is never tracked. */
function anonymous(id: string): Principal {
  return { id, provider: "none" };
}

function baseTurn(overrides: Partial<InboundTurn> = {}): InboundTurn {
  return {
    channel: "test-channel",
    multiUser: false,
    text: "hello",
    sessionKey: "session-1",
    principal: anonymous("wiki-1"),
    logPrefix: "",
    ...overrides,
  };
}

function baseSink(overrides: Partial<TurnSink> = {}): TurnSink & { disposed: boolean; finalized: string[] } {
  const state = { disposed: false, finalized: [] as string[] };
  return {
    onToolStart: () => {},
    finalize: async (text: string) => {
      state.finalized.push(text);
    },
    dispose: () => {
      state.disposed = true;
    },
    ...overrides,
    get disposed() {
      return state.disposed;
    },
    get finalized() {
      return state.finalized;
    },
  } as TurnSink & { disposed: boolean; finalized: string[] };
}

describe("createTurnRunner", () => {
  test("forwards sink.onTextChunk into runTurn's deps when the sink defines it", async () => {
    let receivedOnTextChunk: unknown;
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async (_history, _input, deps) => {
        receivedOnTextChunk = deps.onTextChunk;
        return "reply";
      },
    });

    const onChunk = () => {};
    await runner(baseTurn(), baseSink({ onTextChunk: onChunk }));

    expect(receivedOnTextChunk).toBe(onChunk);
  });

  test("leaves onTextChunk undefined when the sink omits it (Google Chat's non-streaming guarantee)", async () => {
    let receivedOnTextChunk: unknown = "not-yet-set";
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async (_history, _input, deps) => {
        receivedOnTextChunk = deps.onTextChunk;
        return "reply";
      },
    });

    await runner(baseTurn(), baseSink());

    expect(receivedOnTextChunk).toBeUndefined();
  });

  test("forwards sink.onReasoningChunk/onReasoningEnd into runTurn's deps when the sink defines them", async () => {
    let receivedOnReasoningChunk: unknown;
    let receivedOnReasoningEnd: unknown;
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async (_history, _input, deps) => {
        receivedOnReasoningChunk = deps.onReasoningChunk;
        receivedOnReasoningEnd = deps.onReasoningEnd;
        return "reply";
      },
    });

    const onReasoningChunk = () => {};
    const onReasoningEnd = () => {};
    await runner(baseTurn(), baseSink({ onReasoningChunk, onReasoningEnd }));

    expect(receivedOnReasoningChunk).toBe(onReasoningChunk);
    expect(receivedOnReasoningEnd).toBe(onReasoningEnd);
  });

  // Regression: must stay undefined, not default to a no-op — a no-op
  // would make agent-turn.ts's `if (deps.onTextChunk || deps.onReasoningChunk)`
  // branch condition true for every caller, even one that never asked for
  // reasoning display, silently switching them onto the streaming path.
  test("leaves onReasoningChunk/onReasoningEnd undefined when the sink omits them", async () => {
    let receivedOnReasoningChunk: unknown = "not-yet-set";
    let receivedOnReasoningEnd: unknown = "not-yet-set";
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async (_history, _input, deps) => {
        receivedOnReasoningChunk = deps.onReasoningChunk;
        receivedOnReasoningEnd = deps.onReasoningEnd;
        return "reply";
      },
    });

    await runner(baseTurn(), baseSink());

    expect(receivedOnReasoningChunk).toBeUndefined();
    expect(receivedOnReasoningEnd).toBeUndefined();
  });

  test("selects the multi-user system prompt iff turn.multiUser is true", async () => {
    const systems: string[] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "SINGLE", multiUser: "MULTI" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async (_history, _input, deps) => {
        systems.push(deps.system);
        return "reply";
      },
    });

    await runner(baseTurn({ multiUser: false }), baseSink());
    await runner(baseTurn({ multiUser: true }), baseSink());

    expect(systems).toEqual(["SINGLE", "MULTI"]);
  });

  // #176, #150: what a turn is offered follows who the person is (their
  // prompt and tools), and the tools act for that person; the terminal is the
  // operator.
  test("the prompt and the tools follow the person the turn identifies, the terminal as the operator", async () => {
    const systems: string[] = [];
    const whos: unknown[] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "UNUSED", multiUser: "UNUSED" },
      systemPromptsFor: (who) =>
        who.operator ? { singleUser: "OP-SINGLE", multiUser: "OP-MULTI" } : { singleUser: `${who.person.key}-SINGLE`, multiUser: `${who.person.key}-MULTI` },
      buildTools: (_sessionKey, _key, _cb, _finishCb, who) => {
        whos.push(who);
        return {};
      },
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async (_history, _input, deps) => {
        systems.push(deps.system);
        return "reply";
      },
    });

    await runner(baseTurn({ principal: verified("users/1") }), baseSink());
    await runner(baseTurn({ principal: verified("users/1"), multiUser: true }), baseSink());
    await runner(baseTurn({ principal: anonymous("terminal") }), baseSink());

    expect(systems).toEqual(["google-chat:users/1-SINGLE", "google-chat:users/1-MULTI", "OP-SINGLE"]);
    expect(whos).toEqual([
      { operator: false, person: { key: "google-chat:users/1", roles: [] } },
      { operator: false, person: { key: "google-chat:users/1", roles: [] } },
      { operator: true, person: { key: "none:terminal", roles: [] } },
    ]);
  });

  // #150: the directory decides who the person is, and everything per person
  // keys on that, not on the channel's own id.
  test("keys the turn on the person the directory identifies", async () => {
    const keys: Record<string, string[]> = { buildTools: [], track: [], record: [], verbatim: [] };
    const step: StepInfo = { toolCalls: [], toolResults: [], content: [] };
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      identify: async () => ({ ok: true, operator: false, person: { key: "people:alice", roles: ["r"] } }),
      buildTools: (_sk, key) => {
        keys.buildTools!.push(key);
        return {};
      },
      getOrCreateHistory: () => fakeHistory(),
      trackSession: (_sk, key) => keys.track!.push(key),
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      captureVerbatim: async (msg) => {
        keys.verbatim!.push(msg.userId);
      },
      processToolCorrections: async () => {},
      logStep: () => {},
      recordStepFn: (_channel, _sk, owner) => keys.record!.push(owner),
      runTurnFn: async (_history, _input, deps) => {
        deps.onStepFinish?.(step);
        return "reply";
      },
    });

    await runner(baseTurn({ principal: verified("users/1") }), baseSink());

    expect(keys).toEqual({
      buildTools: ["people:alice"],
      track: ["people:alice", "people:alice"],
      record: ["people:alice"],
      verbatim: ["people:alice", "people:alice"],
    });
  });

  // #150: someone the core won't talk to (unknown on a closed instance, or a
  // directory that can't tell) gets the refusal and nothing else: no model,
  // no history, no capture, no tool corrections.
  for (const reason of ["unknown", "unavailable"] as const) {
    test(`a turn refused as ${reason} answers with the refusal and runs nothing`, async () => {
      const ran: string[] = [];
      const runner = createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        identify: async () => ({ ok: false, reason, message: `refused: ${reason}` }),
        buildTools: () => (ran.push("buildTools"), {}),
        getOrCreateHistory: () => (ran.push("history"), fakeHistory()),
        trackSession: () => ran.push("track"),
        registerCaptureCallback: () => ran.push("register"),
        maybeCapture: async () => void ran.push("capture"),
        captureVerbatim: async () => void ran.push("verbatim"),
        processToolCorrections: async () => void ran.push("corrections"),
        logStep: () => {},
        runTurnFn: async () => (ran.push("model"), "reply"),
      });
      const sink = baseSink();

      await runner(baseTurn({ principal: verified("users/1") }), sink);

      expect(ran).toEqual([]);
      expect(sink.finalized).toEqual([`refused: ${reason}`]);
      expect(sink.disposed).toBe(true);
    });
  }

  test("calls buildTools with the turn's sessionKey, the principal's user key, and the sink's onToolStart/onToolFinish", async () => {
    const calls: Array<[string, string, unknown, unknown]> = [];
    const onToolStart = () => {};
    const onToolFinish = () => {};
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: (sessionKey, key, cb, finishCb) => {
        calls.push([sessionKey, key, cb, finishCb]);
        return {};
      },
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ sessionKey: "sk", principal: verified("users/42") }), baseSink({ onToolStart, onToolFinish }));

    expect(calls).toEqual([["sk", "google-chat:users/42", onToolStart, onToolFinish]]);
  });

  test("onStepFinish fans out to logStep, recordStepFn, and sink.onStep", async () => {
    const logged: Array<[string, StepInfo]> = [];
    const recorded: Array<[string, string, string, StepInfo]> = [];
    const sunk: StepInfo[] = [];
    const step: StepInfo = { toolCalls: [], toolResults: [], content: [] };

    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: (prefix, s) => logged.push([prefix, s]),
      recordStepFn: (channel, sessionKey, owner, s) => recorded.push([channel, sessionKey, owner, s]),
      runTurnFn: async (_history, _input, deps) => {
        deps.onStepFinish?.(step);
        return "reply";
      },
    });

    await runner(
      baseTurn({ channel: "chan", sessionKey: "sk", logPrefix: "[p] ", principal: verified("users/42") }),
      baseSink({ onStep: (s) => sunk.push(s) }),
    );

    expect(logged).toEqual([["[p] ", step]]);
    expect(recorded).toEqual([["chan", "sk", "google-chat:users/42", step]]);
    expect(sunk).toEqual([step]);
  });

  test("finalize receives runTurn's exact return value", async () => {
    const sink = baseSink();
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "the final answer",
    });

    await runner(baseTurn(), sink);

    expect(sink.finalized).toEqual(["the final answer"]);
  });

  // Under #6 the display is no longer force-appended off the raw tool output:
  // it is stashed and shown only if the model surfaced it via `present`. The
  // turn runner asks the display store what was surfaced this turn (keyed by
  // sessionKey) and appends only that, so this test injects takeSurfacedDisplays.
  test("appends the display artifacts the model surfaced via present, in order", async () => {
    const sink = baseSink();
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      takeSurfacedDisplays: () => ["MER-1\nhttps://x"],
      runTurnFn: async () => "Here you go.",
    });

    await runner(baseTurn(), sink);

    expect(sink.finalized).toEqual(["Here you go.\n\nMER-1\nhttps://x"]);
  });

  test("appends multiple surfaced artifacts, joined in the order the store returns them", async () => {
    const sink = baseSink();
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      takeSurfacedDisplays: () => ["list-a", "list-b"],
      runTurnFn: async () => "Done.",
    });

    await runner(baseTurn(), sink);

    expect(sink.finalized).toEqual(["Done.\n\nlist-a\n\nlist-b"]);
  });

  test("appends nothing when the model surfaced no artifact (e.g. a prose-only answer)", async () => {
    const sink = baseSink();
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      takeSurfacedDisplays: () => [],
      runTurnFn: async () => "There are 3 open.",
    });

    await runner(baseTurn(), sink);

    expect(sink.finalized).toEqual(["There are 3 open."]);
  });

  test("appends nothing when no display store is wired (takeSurfacedDisplays absent)", async () => {
    const sink = baseSink();
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "plain reply",
    });

    await runner(baseTurn(), sink);

    expect(sink.finalized).toEqual(["plain reply"]);
  });

  test("passes the turn's sessionKey to takeSurfacedDisplays", async () => {
    const sink = baseSink();
    const received: string[] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      takeSurfacedDisplays: (sessionKey) => {
        received.push(sessionKey);
        return [];
      },
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ sessionKey: "sk" }), sink);

    expect(received).toEqual(["sk"]);
  });

  // Regression test: getOrCreateHistory (which can run the context-primer's
  // Qdrant query for a brand-new tracked session) used to be called before
  // the try/finally — a failure there left the sink's own stuck-note timer
  // running forever, since dispose() was never reached. Caught live: a
  // Qdrant 400 on the primer query left a phantom "still stuck" message
  // firing 60s later even though the real error had already been logged.
  test("dispose runs even when getOrCreateHistory itself throws, and the throw propagates", async () => {
    const sink = baseSink();
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: async () => {
        throw new Error("qdrant boom");
      },
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await expect(runner(baseTurn(), sink)).rejects.toThrow("qdrant boom");
    expect(sink.disposed).toBe(true);
    expect(sink.finalized).toEqual([]);
  });

  test("dispose runs even when runTurn throws, and the throw propagates", async () => {
    const sink = baseSink();
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => {
        throw new Error("boom");
      },
    });

    await expect(runner(baseTurn(), sink)).rejects.toThrow("boom");
    expect(sink.disposed).toBe(true);
    expect(sink.finalized).toEqual([]);
  });

  test("processToolCorrections is skipped when the turn throws", async () => {
    let correctionsCalled = false;
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {
        correctionsCalled = true;
      },
      logStep: () => {},
      runTurnFn: async () => {
        throw new Error("boom");
      },
    });

    await expect(runner(baseTurn(), baseSink())).rejects.toThrow("boom");
    expect(correctionsCalled).toBe(false);
  });

  test("processToolCorrections receives every step accumulated during the turn", async () => {
    const stepA: StepInfo = { toolCalls: [{ toolCallId: "1", toolName: "a", input: {} }], toolResults: [], content: [] };
    const stepB: StepInfo = { toolCalls: [{ toolCallId: "2", toolName: "b", input: {} }], toolResults: [], content: [] };
    let received: StepInfo[] = [];

    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async (steps) => {
        received = steps;
      },
      logStep: () => {},
      runTurnFn: async (_history, _input, deps) => {
        deps.onStepFinish?.(stepA);
        deps.onStepFinish?.(stepB);
        return "reply";
      },
    });

    await runner(baseTurn(), baseSink());

    expect(received).toEqual([stepA, stepB]);
  });

  test("two providers issuing the same id reach buildTools as two people, and nobody's principal still gets a key of its own", async () => {
    const keys: string[] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: (_sessionKey, key) => {
        keys.push(key);
        return {};
      },
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ principal: { id: "alice", provider: "static" } }), baseSink());
    await runner(baseTurn({ principal: { id: "alice", provider: "oidc" } }), baseSink());
    await runner(baseTurn({ principal: anonymous("terminal") }), baseSink());

    expect(keys).toEqual(["static:alice", "oidc:alice", "none:terminal"]);
  });

  // encodeURIComponent throws on a lone surrogate, and the vault encodes the
  // key: a channel that doesn't validate its ids must not be able to make the
  // turn reject before it runs.
  test("an id with a lone surrogate still runs the turn, with a well-formed key", async () => {
    const keys: string[] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: (_sessionKey, key) => {
        keys.push(key);
        return {};
      },
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });
    const sink = baseSink();

    await runner(baseTurn({ principal: anonymous("a\ud800") }), sink);

    expect(keys).toEqual(["none:a\ufffd"]);
    expect(sink.finalized).toEqual(["reply"]);
  });

  test("when the principal is verified: trackSession, registerCaptureCallback, and maybeCapture all run, and getOrCreateHistory is asked to track for capture", async () => {
    const tracked: Array<[string, string]> = [];
    const registered: string[] = [];
    const captured: string[] = [];
    let historyTrackForCapture: boolean | undefined;
    const fakeHist = fakeHistory();

    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: (sessionKey, trackForCapture) => {
        historyTrackForCapture = trackForCapture;
        return fakeHist;
      },
      trackSession: (sessionKey, userId) => tracked.push([sessionKey, userId]),
      registerCaptureCallback: (sessionKey) => registered.push(sessionKey),
      maybeCapture: async (sessionKey) => {
        captured.push(sessionKey);
      },
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ sessionKey: "sk", principal: verified("users/42") }), baseSink());

    // Once when the turn starts, once when it ends.
    expect(tracked).toEqual([
      ["sk", "google-chat:users/42"],
      ["sk", "google-chat:users/42"],
    ]);
    expect(registered).toEqual(["sk"]);
    expect(captured).toEqual(["sk"]);
    expect(historyTrackForCapture).toBe(true);
  });

  test("registerCaptureCallback receives both the sink's onToolStart and onToolFinish, so a capture-ping can also patch a status card", async () => {
    const registered: Array<[string, unknown, unknown]> = [];
    const onToolStart = () => {};
    const onToolFinish = () => {};

    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: (sessionKey, cb, finishCb) => registered.push([sessionKey, cb, finishCb]),
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ sessionKey: "sk", principal: verified("u1") }), baseSink({ onToolStart, onToolFinish }));

    expect(registered).toEqual([["sk", onToolStart, onToolFinish]]);
  });

  test("processToolCorrections receives both the sink's onToolStart and onToolFinish", async () => {
    const received: Array<[unknown, unknown]> = [];
    const onToolStart = () => {};
    const onToolFinish = () => {};

    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async (_steps, cb, finishCb) => {
        received.push([cb, finishCb]);
      },
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn(), baseSink({ onToolStart, onToolFinish }));

    expect(received).toEqual([[onToolStart, onToolFinish]]);
  });

  test("getOrCreateHistory receives the verified principal's user key as its third argument (undefined when nobody vouched for it), so a provider can decide whether to seed a context primer", async () => {
    const seenUserIds: Array<string | undefined> = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: (_sessionKey, _trackForCapture, userId) => {
        seenUserIds.push(userId);
        return fakeHistory();
      },
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    await runner(baseTurn({ principal: anonymous("u2") }), baseSink());

    expect(seenUserIds).toEqual(["google-chat:u1", undefined]);
  });

  test("when nobody vouched for the principal: trackSession, registerCaptureCallback, and maybeCapture are all skipped, and getOrCreateHistory is not asked to track for capture", async () => {
    const tracked: unknown[] = [];
    const registered: unknown[] = [];
    const captured: unknown[] = [];
    let historyTrackForCapture: boolean | undefined;
    const fakeHist = fakeHistory();

    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      buildTools: () => ({}),
      getOrCreateHistory: (sessionKey, trackForCapture) => {
        historyTrackForCapture = trackForCapture;
        return fakeHist;
      },
      trackSession: (...args) => tracked.push(args),
      registerCaptureCallback: (...args) => registered.push(args),
      maybeCapture: async (...args) => {
        captured.push(args);
      },
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ sessionKey: "sk", principal: anonymous("terminal") }), baseSink());

    expect(tracked).toEqual([]);
    expect(registered).toEqual([]);
    expect(captured).toEqual([]);
    expect(historyTrackForCapture).toBe(false);
  });

  // The core runs plugin-contributed post-turn guards generically — it knows
  // nothing about what any guard does. These tests exercise that mechanism
  // with synthetic guards. No plugin ships a guard today; the mechanism is kept
  // generic for future use.
  describe("post-turn guards", () => {
    function makeGuard(overrides: Partial<PostTurnGuard> = {}): PostTurnGuard {
      return {
        statusLabel: "Checking…",
        statusId: "guard-1",
        shouldRun: () => true,
        run: async (text) => ({ text, outcome: "success" }),
        ...overrides,
      };
    }

    function baseDeps(
      overrides: Partial<Parameters<typeof createTurnRunner>[0]> = {},
    ): Parameters<typeof createTurnRunner>[0] {
      return {
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        runTurnFn: async () => "model text",
        ...overrides,
      };
    }

    test("delivers the model's text unchanged when no guards are registered", async () => {
      const sink = baseSink();
      const runner = createTurnRunner(baseDeps({ runTurnFn: async () => "untouched" }));
      await runner(baseTurn(), sink);
      expect(sink.finalized).toEqual(["untouched"]);
    });

    test("skips a guard whose shouldRun returns false — no run, no status, no log, text unchanged", async () => {
      const started: unknown[] = [];
      const logged: string[] = [];
      let ran = false;
      const sink = baseSink({ onToolStart: (...a) => started.push(a) });
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "Here you go.",
          logPostTurnGuardFn: (m) => logged.push(m),
          postTurnGuards: [
            makeGuard({
              shouldRun: () => false,
              run: async (t) => {
                ran = true;
                return { text: t, outcome: "success" };
              },
            }),
          ],
        }),
      );

      await runner(baseTurn(), sink);

      expect(ran).toBe(false);
      expect(started).toEqual([]);
      expect(logged).toEqual([]);
      expect(sink.finalized).toEqual(["Here you go."]);
    });

    test("runs an engaged guard: fires its status label/id, replaces the text, forwards its log", async () => {
      const started: unknown[] = [];
      const finished: unknown[] = [];
      const logged: string[] = [];
      const sink = baseSink({ onToolStart: (...a) => started.push(a), onToolFinish: (...a) => finished.push(a) });
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "original",
          logPostTurnGuardFn: (m) => logged.push(m),
          postTurnGuards: [
            makeGuard({
              statusLabel: "Sto verificando…",
              statusId: "g",
              run: async () => ({ text: "rewritten", outcome: "success", log: "did a thing" }),
            }),
          ],
        }),
      );

      await runner(baseTurn(), sink);

      expect(started).toEqual([["Sto verificando…", undefined, "g"]]);
      expect(finished).toEqual([["g", "success"]]);
      expect(logged).toEqual(["did a thing"]);
      expect(sink.finalized).toEqual(["rewritten"]);
    });

    test("forwards a guard's failed outcome to onToolFinish, and still delivers its text", async () => {
      const finished: unknown[] = [];
      const sink = baseSink({ onToolFinish: (...a) => finished.push(a) });
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "original",
          postTurnGuards: [makeGuard({ statusId: "g", run: async () => ({ text: "fallback", outcome: "failed" }) })],
        }),
      );

      await runner(baseTurn(), sink);

      expect(finished).toEqual([["g", "failed"]]);
      expect(sink.finalized).toEqual(["fallback"]);
    });

    test("a guard that throws never blocks delivery: keeps the prior text, reports failed, logs, persists nothing", async () => {
      const finished: unknown[] = [];
      const logged: string[] = [];
      const replaced: string[] = [];
      const sink = baseSink({ onToolFinish: (...a) => finished.push(a) });
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "original",
          getOrCreateHistory: () =>
            fakeHistory({
              replaceLastAssistantMessage: (t) => {
                replaced.push(t);
              },
            }),
          logPostTurnGuardFn: (m) => logged.push(m),
          postTurnGuards: [
            makeGuard({
              statusId: "boom",
              run: async () => {
                throw new Error("kaboom");
              },
            }),
          ],
        }),
      );

      await runner(baseTurn(), sink);

      expect(finished).toEqual([["boom", "failed"]]);
      expect(sink.finalized).toEqual(["original"]);
      expect(replaced).toEqual([]);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("kaboom");
    });

    test("runs guards before appending surfaced displays", async () => {
      const sink = baseSink();
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "flagged",
          takeSurfacedDisplays: () => ["MER-1\nhttps://x"],
          postTurnGuards: [makeGuard({ run: async () => ({ text: "clean", outcome: "success" }) })],
        }),
      );

      await runner(baseTurn(), sink);

      // the display is appended to the guard's rewritten text ("clean"), not
      // the model's original ("flagged") — proving guards run first
      expect(sink.finalized).toEqual(["clean\n\nMER-1\nhttps://x"]);
    });

    test("persists the guard's text to history when it changed the text", async () => {
      const replaced: string[] = [];
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "original",
          getOrCreateHistory: () =>
            fakeHistory({
              replaceLastAssistantMessage: (t) => {
                replaced.push(t);
              },
            }),
          postTurnGuards: [makeGuard({ run: async () => ({ text: "changed", outcome: "success" }) })],
        }),
      );

      await runner(baseTurn(), baseSink());

      expect(replaced).toEqual(["changed"]);
    });

    test("does not persist to history when the guard returned the same text", async () => {
      const replaced: string[] = [];
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "same",
          getOrCreateHistory: () =>
            fakeHistory({
              replaceLastAssistantMessage: (t) => {
                replaced.push(t);
              },
            }),
          postTurnGuards: [makeGuard({ run: async (t) => ({ text: t, outcome: "success" }) })],
        }),
      );

      await runner(baseTurn(), baseSink());

      expect(replaced).toEqual([]);
    });

    test("runs multiple guards in order, each seeing the previous guard's output", async () => {
      const sink = baseSink();
      const seen: string[] = [];
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "a",
          postTurnGuards: [
            makeGuard({
              statusId: "g1",
              run: async (t) => {
                seen.push(t);
                return { text: `${t}b`, outcome: "success" };
              },
            }),
            makeGuard({
              statusId: "g2",
              run: async (t) => {
                seen.push(t);
                return { text: `${t}c`, outcome: "success" };
              },
            }),
          ],
        }),
      );

      await runner(baseTurn(), sink);

      expect(seen).toEqual(["a", "ab"]);
      expect(sink.finalized).toEqual(["abc"]);
    });
  });

  describe("verbatim capture", () => {
    test("captures the user input and the model's answer verbatim, in order, scoped to the turn's identity", async () => {
      const captured: Array<{ sessionKey: string; userId: string; role: string; content: string }> = [];
      const runner = createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        captureVerbatim: async (msg) => {
          captured.push(msg);
        },
        runTurnFn: async () => "the answer",
      });

      await runner(baseTurn({ sessionKey: "sk", principal: verified("users/42"), text: "the question" }), baseSink());

      // Keyed on the same path-safe per-person id the wiki notes use, not the raw one.
      expect(captured).toEqual([
        { sessionKey: "sk", userId: "google-chat:users/42", role: "user", content: "the question" },
        { sessionKey: "sk", userId: "google-chat:users/42", role: "assistant", content: "the answer" },
      ]);
    });

    test("does not capture anything when nobody vouched for the principal", async () => {
      let called = false;
      const runner = createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        captureVerbatim: async () => {
          called = true;
        },
        runTurnFn: async () => "reply",
      });

      await runner(baseTurn({ principal: anonymous("conv-1") }), baseSink());

      expect(called).toBe(false);
    });

    test("captures the guard-corrected assistant text, not the raw model text", async () => {
      const captured: Array<{ role: string; content: string }> = [];
      const runner = createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        captureVerbatim: async (msg) => {
          captured.push({ role: msg.role, content: msg.content });
        },
        postTurnGuards: [
          {
            statusLabel: "…",
            statusId: "g",
            shouldRun: () => true,
            run: async () => ({ text: "rewritten", outcome: "success" }),
          },
        ],
        runTurnFn: async () => "original",
      });

      await runner(baseTurn({ principal: verified("u1") }), baseSink());

      expect(captured.find((m) => m.role === "assistant")?.content).toBe("rewritten");
    });

    // The archive holds the verbatim user<->model exchange only. Surfaced
    // `present` displays are formatting-layer artifacts (like tool results,
    // excluded by design), so the captured assistant text must be the model's
    // own words, without the appended display block.
    test("excludes surfaced present() displays from the captured assistant text", async () => {
      const captured: Array<{ role: string; content: string }> = [];
      const sink = baseSink();
      const runner = createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        takeSurfacedDisplays: () => ["MER-1\nhttps://x"],
        captureVerbatim: async (msg) => {
          captured.push({ role: msg.role, content: msg.content });
        },
        runTurnFn: async () => "Here you go.",
      });

      await runner(baseTurn({ principal: verified("u1") }), sink);

      // what the user saw includes the display...
      expect(sink.finalized).toEqual(["Here you go.\n\nMER-1\nhttps://x"]);
      // ...but the archived assistant message is the model's own words only
      expect(captured.find((m) => m.role === "assistant")?.content).toBe("Here you go.");
    });

    // Fail-soft: the archive is pure enrichment (principle #3). A failure
    // capturing it must never take down the turn — the answer is already
    // delivered, and an unhandled rejection here would otherwise propagate out
    // of the awaited handler.
    test("a failing captureVerbatim never breaks the turn: it still finalizes and runs corrections", async () => {
      let correctionsRan = false;
      const sink = baseSink();
      const runner = createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {
          correctionsRan = true;
        },
        logStep: () => {},
        captureVerbatim: async () => {
          throw new Error("qdrant down");
        },
        runTurnFn: async () => "delivered anyway",
      });

      await expect(runner(baseTurn({ principal: verified("u1") }), sink)).resolves.toBeUndefined();
      expect(sink.finalized).toEqual(["delivered anyway"]);
      expect(correctionsRan).toBe(true);
    });

    test("does nothing when no captureVerbatim is wired (verbatim archive disabled)", async () => {
      const sink = baseSink();
      const runner = createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        runTurnFn: async () => "reply",
      });

      await expect(runner(baseTurn({ principal: verified("u1") }), sink)).resolves.toBeUndefined();
      expect(sink.finalized).toEqual(["reply"]);
    });
  });

  // Regression for #154: HTTP never serialised two /turn calls on the same
  // conversation, so both ran on one SessionHistory at once and its messages
  // interleaved (user, user, assistant, assistant).
  describe("concurrent turns", () => {
    /** A promise plus the function that resolves it. */
    function gate(): { promise: Promise<void>; open: () => void } {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    function runnerWith(overrides: Partial<Parameters<typeof createTurnRunner>[0]>) {
      return createTurnRunner({
        model: {} as any,
        systemPrompts: { singleUser: "s", multiUser: "m" },
        buildTools: () => ({}),
        getOrCreateHistory: () => fakeHistory(),
        trackSession: () => {},
        registerCaptureCallback: () => {},
        maybeCapture: async () => {},
        processToolCorrections: async () => {},
        logStep: () => {},
        ...overrides,
      });
    }

    test("two turns on the same session run one after the other, post-turn work included", async () => {
      const history = createSessionHistory(async () => "summary");
      const firstGate = gate();
      const events: string[] = [];
      const runner = runnerWith({
        getOrCreateHistory: () => history,
        runTurnFn: async (h, input) => {
          events.push(`start:${input}`);
          await h.addUserMessage(input);
          if (input === "first") await firstGate.promise;
          await h.addAssistantMessage(`answer to ${input}`);
          return `answer to ${input}`;
        },
        processToolCorrections: async () => {
          events.push("corrections");
        },
      });

      const first = runner(baseTurn({ text: "first" }), baseSink());
      const second = runner(baseTurn({ text: "second" }), baseSink());
      await settle();
      expect(events).toEqual(["start:first"]);

      firstGate.open();
      await Promise.all([first, second]);
      expect(events).toEqual(["start:first", "corrections", "start:second", "corrections"]);
      expect(history.getMessages()).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "answer to first" },
        { role: "user", content: "second" },
        { role: "assistant", content: "answer to second" },
      ]);
    });

    test("turns on different sessions run in parallel", async () => {
      const firstGate = gate();
      const started: string[] = [];
      const runner = runnerWith({
        runTurnFn: async (_h, input) => {
          started.push(input);
          if (input === "first") await firstGate.promise;
          return "reply";
        },
      });

      const first = runner(baseTurn({ text: "first", sessionKey: "a" }), baseSink());
      await runner(baseTurn({ text: "second", sessionKey: "b" }), baseSink());
      expect(started).toEqual(["first", "second"]);
      firstGate.open();
      await first;
    });

    test("a turn aborted while it waits never runs, and its sink is still released", async () => {
      const firstGate = gate();
      const ran: string[] = [];
      const tracked: string[] = [];
      const runner = runnerWith({
        trackSession: (key) => tracked.push(key),
        runTurnFn: async (_h, input) => {
          ran.push(input);
          if (input === "first") await firstGate.promise;
          return "reply";
        },
      });
      const controller = new AbortController();
      const waitingSink = baseSink();

      const first = runner(baseTurn({ text: "first", principal: verified("u1") }), baseSink());
      const second = runner(
        baseTurn({ text: "second", principal: verified("u1"), abortSignal: controller.signal }),
        waitingSink,
      );
      controller.abort();
      await second;
      // Released while the first turn is still running.
      expect(waitingSink.disposed).toBe(true);
      firstGate.open();
      await first;

      expect(ran).toEqual(["first"]);
      // Only the first turn tracked the session (at its start and its end).
      expect(tracked).toEqual(["session-1", "session-1"]);
      expect(waitingSink.finalized).toEqual([]);
      expect(waitingSink.disposed).toBe(true);
    });

    test("a turn waits for other work holding the same session in the shared lock", async () => {
      const sessionLock = createSessionLock();
      const sweepGate = gate();
      const ran: string[] = [];
      const runner = runnerWith({
        sessionLock,
        runTurnFn: async (_h, input) => {
          ran.push(input);
          return "reply";
        },
      });

      const sweep = sessionLock.run("session-1", () => sweepGate.promise);
      const turn = runner(baseTurn({ text: "hello" }), baseSink());
      await settle();
      expect(ran).toEqual([]);

      sweepGate.open();
      await Promise.all([sweep, turn]);
      expect(ran).toEqual(["hello"]);
    });

    // A turn longer than the idle timeout used to look idle the moment it
    // ended (activity was recorded only at its start), and the sweep, which
    // waited for it on the lock, closed the session right away.
    test("a tracked turn records activity when it ends too", async () => {
      const touches: number[] = [];
      let clock = 1_000;
      const runner = runnerWith({
        now: () => clock,
        trackSession: (_key, _user, at) => touches.push(at),
        runTurnFn: async () => {
          clock = 5_000;
          return "reply";
        },
      });

      await runner(baseTurn({ principal: verified("u1") }), baseSink());
      expect(touches).toEqual([1_000, 5_000]);
    });
  });
});
