import { describe, expect, test } from "bun:test";
import { createTurnRunner, parseStallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS, OPENING_CUE, OPENING_NOTE, PREFERRED_LANGUAGE_NOTE, PREFERRED_NAME_NOTE, RECAP_NOTE, SHOWN_LISTS_NOTE, RESUMED_LINE, type PostTurnGuard } from "./turn-runner.ts";
import type { InboundTurn, TurnSink } from "./provider.ts";
import type { Principal } from "@mercury-fw/channel-types";
import { createSessionHistory, type SessionHistory } from "../session/history.ts";
import { OPERATOR_PRINCIPAL } from "../identity/people.ts";
import { createSessionLock } from "./session-lock.ts";
import type { StepInfo } from "../session/step-info.ts";

function fakeHistory(overrides: Partial<SessionHistory> = {}): SessionHistory {
  return {
    addUserMessage: async () => {},
    addAssistantMessage: async () => {},
    replaceLastAssistantMessage: () => {},
    getMessages: () => [],
    getCharCount: () => 0,
    getCapturable: () => [],
    primer: () => undefined,
    ...overrides,
  };
}

/** A principal a provider vouched for: the turn is tracked for capture. */
function verified(id: string): Principal {
  return { id, provider: "google-chat" };
}

/** The terminal's principal, the operator: the turn is never tracked. */
function anonymous(_id: string): Principal {
  return OPERATOR_PRINCIPAL;
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
  // #163: a channel marks a conversation its client reopens; the history is
  // rebuilt from the archive only for those, and only for a tracked person.
  test("hands the turn's resume to getOrCreateHistory for a tracked turn only", async () => {
    const seen: unknown[][] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: (...args: unknown[]) => (seen.push(args), fakeHistory()),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ principal: verified("u1"), resume: { maxChars: 500 } }), baseSink());
    await runner(baseTurn({ principal: verified("u1"), sessionKey: "session-2" }), baseSink());
    await runner(baseTurn({ sessionKey: "session-3", resume: {} }), baseSink());

    expect(seen.map((args) => args[3])).toEqual([{ maxChars: 500 }, undefined, undefined]);
  });

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
        deps.onTextChunk?.("he");
        deps.onTextChunk?.("llo");
        return "reply";
      },
    });

    const chunks: string[] = [];
    await runner(baseTurn(), baseSink({ onTextChunk: (c) => chunks.push(c) }));

    // Wrapped to count what's streamed (#238), each chunk still reaching the sink.
    expect(typeof receivedOnTextChunk).toBe("function");
    expect(chunks).toEqual(["he", "llo"]);
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
        deps.onReasoningChunk?.("think", "r1");
        return "reply";
      },
    });

    const reasoning: Array<[string, string]> = [];
    const onReasoningEnd = () => {};
    await runner(baseTurn(), baseSink({ onReasoningChunk: (c, id) => reasoning.push([c, id]), onReasoningEnd }));

    // Wrapped to count what's streamed (#238), each chunk still reaching the sink.
    expect(typeof receivedOnReasoningChunk).toBe("function");
    expect(reasoning).toEqual([["think", "r1"]]);
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
      buildTools: (_sessionKey, _key, who) => {
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
      buildTools: (sessionKey, key, _who, cb, finishCb) => {
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

    await runner(baseTurn({ principal: verified("a\ud800") }), sink);

    expect(keys).toEqual(["google-chat:a\ufffd"]);
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

  test("processToolCorrections receives both the sink's onToolStart and onToolFinish, and whose turn it is", async () => {
    const received: Array<[unknown, unknown, unknown]> = [];
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
      processToolCorrections: async (_steps, cb, finishCb, key) => {
        received.push([cb, finishCb, key]);
      },
      logStep: () => {},
      runTurnFn: async () => "reply",
    });

    await runner(baseTurn({ principal: verified("u1") }), baseSink({ onToolStart, onToolFinish }));

    expect(received).toEqual([[onToolStart, onToolFinish, "google-chat:u1"]]);
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
        statusLabel: () => "Checking…",
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
              statusLabel: () => "Sto verificando…",
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

    // #280: a guard's status line and what it adds read in the language of
    // the person the turn is for, like every other text they see.
    test("a guard gets the texts of the turn's person, for its status line and its run", async () => {
      const started: string[] = [];
      const sink = { ...baseSink(), onToolStart: (label: string) => void started.push(label) };
      const asked: string[] = [];
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "answer",
          translatorFor: (key) => {
            asked.push(key);
            return (k) => `${key}/${k}`;
          },
          postTurnGuards: [
            makeGuard({
              statusLabel: (t) => t("g.status"),
              statusId: "g",
              run: async (text, _steps, t) => ({ text: `${text} ${t("g.added")}`, outcome: "success" }),
            }),
          ],
        }),
      );
      await runner(baseTurn({ principal: verified("u1") }), sink);
      expect(started).toEqual(["google-chat:u1/g.status"]);
      expect(sink.finalized).toEqual(["answer google-chat:u1/g.added"]);
      expect(new Set(asked)).toEqual(new Set(["google-chat:u1"]));
    });

    // Review of #280: a guard's status line became a function call made
    // outside the guard's try; one that threw took the whole turn down
    // instead of leaving the text as it was.
    test("a guard whose status line throws is skipped like one whose run throws: the text is delivered", async () => {
      const logged: string[] = [];
      const finished: Array<[string, string]> = [];
      const sink = { ...baseSink(), onToolFinish: (id: string, outcome: string) => void finished.push([id, outcome]) };
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "answer",
          logPostTurnGuardFn: (m) => logged.push(m),
          postTurnGuards: [
            makeGuard({
              statusLabel: () => {
                throw new Error("no label");
              },
              statusId: "g",
            }),
          ],
        }),
      );
      await runner(baseTurn(), sink);
      expect(sink.finalized).toEqual(["answer"]);
      // Its status never started, so nothing finishes either.
      expect(finished).toEqual([]);
      expect(logged).toEqual(['[post-turn-guard] guard "g" threw, kept text unchanged: no label']);
    });

    test("a guard gets the core's English texts when the composition gives no translator", async () => {
      const started: string[] = [];
      const sink = { ...baseSink(), onToolStart: (label: string) => void started.push(label) };
      const runner = createTurnRunner(
        baseDeps({
          runTurnFn: async () => "answer",
          postTurnGuards: [makeGuard({ statusLabel: (t) => t("core.status.searching"), statusId: "g" })],
        }),
      );
      await runner(baseTurn(), sink);
      expect(started).toEqual(["Searching…"]);
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
            statusLabel: () => "…",
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

    // The archived `content` is the model's own words, what goes back to the
    // model. The surfaced `present` displays travel next to it (#215: a
    // reopened conversation lost the lists the person had seen).
    test("archives surfaced present() displays next to the model's own text, not in it", async () => {
      const captured: Array<{ sessionKey: string; userId: string; role: string; content: string; displays?: string[] }> = [];
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
          captured.push(msg);
        },
        runTurnFn: async () => "Here you go.",
      });

      await runner(baseTurn({ principal: verified("u1") }), sink);

      expect(sink.finalized).toEqual(["Here you go.\n\nMER-1\nhttps://x"]);
      expect(captured.find((m) => m.role === "assistant")).toEqual({
        sessionKey: expect.any(String),
        userId: expect.any(String),
        role: "assistant",
        content: "Here you go.",
        displays: ["MER-1\nhttps://x"],
      });
    });

    test("archives a turn whose answer is only surfaced displays", async () => {
      const captured: Array<{ role: string; content: string; displays?: string[] }> = [];
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
          captured.push({ role: msg.role, content: msg.content, displays: msg.displays });
        },
        runTurnFn: async () => "",
      });

      await runner(baseTurn({ principal: verified("u1") }), sink);

      expect(sink.finalized).toEqual(["MER-1\nhttps://x"]);
      expect(captured.find((m) => m.role === "assistant")).toEqual({ role: "assistant", content: "", displays: ["MER-1\nhttps://x"] });
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

// #216: how a person wants to be called reaches the prompt on every one-to-one
// turn, and the first time Mercury knows nothing about them it speaks first,
// asking. An opening for someone it already knows says nothing at all.
describe("createTurnRunner: preferred name and opening turn", () => {
  function setup(opts: { names?: Record<string, string>; languages?: Record<string, string> } = {}) {
    const calls: Array<{ text: string; system: string }> = [];
    const histories: string[] = [];
    const captured: Array<{ role: string; content: string }> = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: (sessionKey: string) => (histories.push(sessionKey), fakeHistory()),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      captureVerbatim: async (msg) => {
        captured.push({ role: msg.role, content: msg.content });
      },
      preferredName: (key) => opts.names?.[key],
      preferredLanguage: (key) => opts.languages?.[key],
      runTurnFn: async (_history, text, deps) => {
        calls.push({ text, system: deps.system });
        return "Ciao! Come vuoi che ti chiami?";
      },
    });
    return { runner, calls, histories, captured };
  }

  test("a known name is appended to the one-to-one prompt", async () => {
    const { runner, calls } = setup({ names: { "google-chat:u1": "Luca" } });
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(calls).toEqual([{ text: "hello", system: `single\n\n${PREFERRED_NAME_NOTE("Luca")}` }]);
  });

  // #279: the fixed texts follow the language the person saved; the model's
  // answers must follow it too, or the two read in different languages.
  test("a saved language is appended to the one-to-one prompt, after the name", async () => {
    const { runner, calls } = setup({ names: { "google-chat:u1": "Luca" }, languages: { "google-chat:u1": "it" } });
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(calls).toEqual([
      { text: "hello", system: `single\n\n${PREFERRED_NAME_NOTE("Luca")}\n\n${PREFERRED_LANGUAGE_NOTE("it")}` },
    ]);
  });

  test("a saved language reaches an opening too, and a shared space never gets one person's", async () => {
    const { runner, calls } = setup({ languages: { "google-chat:u1": "it" } });
    await runner(baseTurn({ principal: verified("u1"), opening: true, text: "" }), baseSink());
    await runner(baseTurn({ principal: verified("u1"), multiUser: true }), baseSink());
    expect(calls).toEqual([
      { text: OPENING_CUE, system: `single\n\n${OPENING_NOTE}\n\n${PREFERRED_LANGUAGE_NOTE("it")}` },
      { text: "hello", system: "multi" },
    ]);
  });

  test("the language note names the language in English, and its code", () => {
    expect(PREFERRED_LANGUAGE_NOTE("it")).toBe("The person asked you to talk to them in Italian (it): always answer in it.");
    expect(PREFERRED_LANGUAGE_NOTE("pt-br")).toBe(
      "The person asked you to talk to them in Brazilian Portuguese (pt-br): always answer in it.",
    );
  });

  test("no name, a normal turn: the prompt is left as it is, nobody is asked anything", async () => {
    const { runner, calls } = setup();
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(calls).toEqual([{ text: "hello", system: "single" }]);
  });

  test("a shared space never gets one person's name", async () => {
    const { runner, calls } = setup({ names: { "google-chat:u1": "Luca" } });
    await runner(baseTurn({ principal: verified("u1"), multiUser: true }), baseSink());
    expect(calls).toEqual([{ text: "hello", system: "multi" }]);
  });

  test("an opening for someone without a name runs on the cue and archives only the greeting", async () => {
    const { runner, calls, captured } = setup();
    const sink = baseSink();
    await runner(baseTurn({ principal: verified("u1"), opening: true, text: "" }), sink);
    expect(calls).toEqual([{ text: OPENING_CUE, system: `single\n\n${OPENING_NOTE}` }]);
    expect(sink.finalized).toEqual(["Ciao! Come vuoi che ti chiami?"]);
    expect(captured).toEqual([{ role: "assistant", content: "Ciao! Come vuoi che ti chiami?" }]);
  });

  test("an opening for someone with a name says nothing: no model, no history, nothing archived", async () => {
    const { runner, calls, histories, captured } = setup({ names: { "google-chat:u1": "Luca" } });
    const sink = baseSink();
    await runner(baseTurn({ principal: verified("u1"), opening: true, text: "" }), sink);
    expect(calls).toEqual([]);
    expect(histories).toEqual([]);
    expect(captured).toEqual([]);
    expect(sink.finalized).toEqual([""]);
    expect(sink.disposed).toBe(true);
  });

  test("an opening in a shared space says nothing", async () => {
    const { runner, calls, histories } = setup();
    const sink = baseSink();
    await runner(baseTurn({ principal: verified("u1"), opening: true, text: "", multiUser: true }), sink);
    expect(calls).toEqual([]);
    expect(histories).toEqual([]);
    expect(sink.finalized).toEqual([""]);
  });

  test("an opening that fails releases the sink and archives nothing", async () => {
    const captured: unknown[] = [];
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
      captureVerbatim: async (msg) => {
        captured.push(msg);
      },
      preferredName: () => undefined,
      runTurnFn: async () => {
        throw new Error("model down");
      },
    });
    const sink = baseSink();
    await expect(runner(baseTurn({ principal: verified("u1"), opening: true, text: "" }), sink)).rejects.toThrow("model down");
    expect(sink.disposed).toBe(true);
    expect(sink.finalized).toEqual([]);
    expect(captured).toEqual([]);
  });

  // #225: "ask how they'd like to be called" came back from a small model as
  // "Come vorrei che mi chiamassi?": the question asked the wrong way round.
  test("the opening note asks for the person's name, with nothing to turn around", () => {
    expect(OPENING_NOTE).toContain("ask the person what name you should use for them");
    expect(OPENING_NOTE).toContain("their name, not yours");
    expect(OPENING_NOTE).not.toContain("how they'd like to be called");
  });

  test("the opening note overrides the tone's rules against introducing itself and asking", () => {
    expect(OPENING_NOTE).toContain("set_preferred_name");
    expect(OPENING_NOTE).toContain("overrides");
    expect(PREFERRED_NAME_NOTE("Luca")).toContain("Luca");
  });
});

// #230: the history keeps only the text of each answer, so a turn after a list
// was shown the model no longer knew which one, and retyped it with made-up
// keys. The lists it showed are named at the end of the prompt.
describe("createTurnRunner: lists already shown", () => {
  function setup(shown: Array<{ ref: string; label: string }>, names: Record<string, string> = {}) {
    const systems: string[] = [];
    const asked: string[] = [];
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
      preferredName: (key) => names[key],
      shownLists: (sessionKey) => (asked.push(sessionKey), shown),
      runTurnFn: async (_history, _text, deps) => {
        systems.push(deps.system);
        return "ok";
      },
    });
    return { runner, systems, asked };
  }

  test("names each list shown in the conversation, at the very end of the prompt", async () => {
    const { runner, systems, asked } = setup(
      [
        { ref: "d1", label: 'jira issue search --jql "a" (2 items)' },
        { ref: "d3", label: "" },
      ],
      { "google-chat:u1": "Luca" },
    );
    await runner(baseTurn({ principal: verified("u1"), sessionKey: "s-1" }), baseSink());
    expect(asked).toEqual(["s-1"]);
    expect(systems).toEqual([
      `single\n\n${PREFERRED_NAME_NOTE("Luca")}\n\n${SHOWN_LISTS_NOTE([
        { ref: "d1", label: 'jira issue search --jql "a" (2 items)' },
        { ref: "d3", label: "" },
      ])}`,
    ]);
  });

  test("the note lists refs and labels, and says how to show one again", () => {
    expect(SHOWN_LISTS_NOTE([{ ref: "d1", label: "jira issue search A (2 items)" }, { ref: "d3", label: "" }])).toBe(
      [
        "Lists already shown in this conversation (most recent last):",
        "- d1: jira issue search A (2 items)",
        "- d3",
        "To show one again, call present with its ref. For up-to-date data, or if present says the ref is gone, run its command again. Never retype a list.",
      ].join("\n"),
    );
  });

  test("adds nothing when no list was shown", async () => {
    const { runner, systems } = setup([]);
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(systems).toEqual(["single"]);
  });

  test("names them in a shared space too", async () => {
    const { runner, systems } = setup([{ ref: "d1", label: "x (1 item)" }]);
    await runner(baseTurn({ principal: verified("u1"), multiUser: true }), baseSink());
    expect(systems).toEqual([`multi\n\n${SHOWN_LISTS_NOTE([{ ref: "d1", label: "x (1 item)" }])}`]);
  });
});

// #233: the primer led the history as the assistant's own message, so the model
// picked an earlier conversation's thread back up and listed its data unasked.
// It comes as background in the prompt, framed as possibly out of date.
describe("createTurnRunner: the primer as background", () => {
  function setup(primer: { current: string; recap: string } | undefined) {
    const systems: string[] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: () => fakeHistory({ primer: () => primer }),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      preferredName: () => "Luca",
      shownLists: () => [{ ref: "d1", label: "x (1 item)" }],
      runTurnFn: async (_history, _text, deps) => {
        systems.push(deps.system);
        return "ok";
      },
    });
    return { runner, systems };
  }

  test("goes into the prompt before the name and the lists already shown: the current state as is, the recap framed", async () => {
    const { runner, systems } = setup({ current: "Open references:\n- [REQ:t1]", recap: "Last session:\n- asked for SUP tickets" });
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(systems).toEqual([
      [
        "single",
        "Open references:\n- [REQ:t1]",
        RECAP_NOTE("Last session:\n- asked for SUP tickets"),
        PREFERRED_NAME_NOTE("Luca"),
        SHOWN_LISTS_NOTE([{ ref: "d1", label: "x (1 item)" }]),
      ].join("\n\n"),
    ]);
  });

  test("adds nothing without a primer", async () => {
    const { runner, systems } = setup(undefined);
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(systems[0]).not.toContain("Background from");
  });

  test("a primer with no recap brings only the current state, unframed", async () => {
    const { runner, systems } = setup({ current: "Wiki index:\n- curated/team.md", recap: "" });
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(systems[0]).toContain("single\n\nWiki index:\n- curated/team.md\n\n");
    expect(systems[0]).not.toContain("Background from");
  });

  test("frames the recap as possibly out of date, only when the person refers to it, never as current", () => {
    expect(RECAP_NOTE("X")).toBe(
      "Background from your earlier conversations with this person, for reference only (it may be out of date):\n" +
        "X\n" +
        "Don't bring it up unless the person refers to it, never present it as current, and read any data from a service again with its tool.",
    );
  });
});

// #238: a turn that answered without tools, or never ended, left no trace in
// the log: a model looping in its reasoning looked like a dead service.
describe("createTurnRunner: turn log", () => {
  function setup(run: (deps: { onReasoningChunk?: (c: string, id: string) => void; onTextChunk?: (c: string) => void; onStepFinish?: (s: StepInfo) => void; onFinish?: (reason: string, error?: string) => void }, tick: () => void) => Promise<string>) {
    const lines: string[] = [];
    let now = 1_000;
    let beat: (() => void) | undefined;
    let stopped = 0;
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
      now: () => now,
      logTurnFn: (line) => lines.push(line),
      heartbeat: (fn, ms) => {
        expect(ms).toBe(60_000);
        beat = fn;
        return () => (stopped += 1);
      },
      runTurnFn: async (_h, _t, deps) =>
        run(deps, () => {
          now += 60_000;
          beat?.();
        }),
    });
    return { runner, lines, advance: (ms: number) => (now += ms), stoppedCount: () => stopped };
  }

  const step = (calls: number): StepInfo => ({ toolCalls: Array.from({ length: calls }, (_, i) => ({ toolCallId: `c${i}`, toolName: "x", input: {} })), toolResults: [], content: [] }) as unknown as StepInfo;

  test("logs the start, then the end with time, steps, tool calls and how much it wrote", async () => {
    const { runner, lines, advance, stoppedCount } = setup(async (deps) => {
      deps.onReasoningChunk?.("abcd", "r1");
      deps.onStepFinish?.(step(2));
      deps.onStepFinish?.(step(0));
      deps.onTextChunk?.("hello");
      advance(12_300);
      return "hello";
    });
    await runner(baseTurn({ logPrefix: "[http:s] " }), baseSink({ onTextChunk: () => {}, onReasoningChunk: () => {} }));
    expect(lines).toEqual([
      "[http:s] [turn] start",
      "[http:s] [turn] done in 12.3s: 2 steps, 2 tool calls, reasoning 4 chars, answer 5 chars",
    ]);
    expect(stoppedCount()).toBe(1);
  });

  test("says it's still running every minute, with what it has written so far", async () => {
    const { runner, lines } = setup(async (deps, tick) => {
      deps.onReasoningChunk?.("x".repeat(1840), "r1");
      tick();
      deps.onReasoningChunk?.("y".repeat(100), "r1");
      deps.onStepFinish?.(step(1));
      tick();
      return "ok";
    });
    await runner(baseTurn({ logPrefix: "[p] " }), baseSink({ onReasoningChunk: () => {} }));
    expect(lines.slice(1, 3)).toEqual([
      "[p] [turn] still running after 60s: reasoning 1840 chars, answer 0 chars, 0 tool calls",
      "[p] [turn] still running after 120s: reasoning 1940 chars, answer 0 chars, 1 tool call",
    ]);
  });

  test("logs a failure with its message, and stops the heartbeat", async () => {
    const { runner, lines, advance, stoppedCount } = setup(async () => {
      advance(4_100);
      throw new Error("model down");
    });
    await expect(runner(baseTurn({ logPrefix: "[p] " }), baseSink())).rejects.toThrow("model down");
    expect(lines).toEqual(["[p] [turn] start", "[p] [turn] failed after 4.1s: model down"]);
    expect(stoppedCount()).toBe(1);
  });

  test("logs a turn whose client went away as cancelled", async () => {
    const abort = new AbortController();
    const { runner, lines, stoppedCount } = setup(async () => {
      abort.abort();
      throw new Error("aborted");
    });
    await expect(runner(baseTurn({ logPrefix: "[p] ", abortSignal: abort.signal }), baseSink())).rejects.toThrow();
    expect(lines).toEqual(["[p] [turn] start", "[p] [turn] cancelled after 0.0s"]);
    expect(stoppedCount()).toBe(1);
  });

  test("counts the answer from the final text on a channel that doesn't stream", async () => {
    const { runner, lines } = setup(async () => "final answer");
    await runner(baseTurn({ logPrefix: "[p] " }), baseSink());
    expect(lines.at(-1)).toBe("[p] [turn] done in 0.0s: 0 steps, 0 tool calls, reasoning 0 chars, answer 12 chars");
  });

  // #243: a generation cut short looked exactly like a finished one in the log.
  test("ends the done line with how the generation ended", async () => {
    const { runner, lines } = setup(async (deps) => {
      deps.onFinish?.("stop");
      return "ok";
    });
    await runner(baseTurn({ logPrefix: "[p] " }), baseSink());
    expect(lines.at(-1)).toBe("[p] [turn] done in 0.0s: 0 steps, 0 tool calls, reasoning 0 chars, answer 2 chars, finish stop");
  });

  test("keeps tool-calls, content-filter and other as successes", async () => {
    for (const reason of ["tool-calls", "content-filter", "other"]) {
      const { runner, lines } = setup(async (deps) => {
        deps.onFinish?.(reason);
        return "ok";
      });
      await runner(baseTurn({ logPrefix: "[p] " }), baseSink());
      expect(lines.at(-1)).toEndWith(`answer 2 chars, finish ${reason}`);
    }
  });

  test("fails a turn cut at a token limit, and releases its sink", async () => {
    const { runner, lines, stoppedCount } = setup(async (deps) => {
      deps.onTextChunk?.("half an ans");
      deps.onFinish?.("length");
      return "half an ans";
    });
    const sink = baseSink({ onTextChunk: () => {} });
    await expect(runner(baseTurn({ logPrefix: "[p] " }), sink)).rejects.toThrow("the model stopped: length");
    expect(lines).toEqual(["[p] [turn] start", "[p] [turn] failed after 0.0s: the model stopped: length"]);
    expect(sink.finalized).toEqual([]);
    expect(sink.disposed).toBe(true);
    expect(stoppedCount()).toBe(1);
  });

  test("fails a turn whose stream broke, with the error's message", async () => {
    const { runner, lines } = setup(async (deps) => {
      deps.onFinish?.("error", "socket hang up");
      return "half";
    });
    await expect(runner(baseTurn({ logPrefix: "[p] " }), baseSink())).rejects.toThrow("the model stopped: error (socket hang up)");
    expect(lines.at(-1)).toBe("[p] [turn] failed after 0.0s: the model stopped: error (socket hang up)");
  });

  test("fails a turn ending on error even without a message", async () => {
    const { runner } = setup(async (deps) => {
      deps.onFinish?.("error");
      return "half";
    });
    await expect(runner(baseTurn({ logPrefix: "[p] " }), baseSink())).rejects.toThrow(/^the model stopped: error$/);
  });

  test("leaves the done line as it was when no finish reason arrived", async () => {
    const { runner, lines } = setup(async () => "ok");
    await runner(baseTurn({ logPrefix: "[p] " }), baseSink());
    expect(lines.at(-1)).toBe("[p] [turn] done in 0.0s: 0 steps, 0 tool calls, reasoning 0 chars, answer 2 chars");
  });

  test("marks an opening turn", async () => {
    const { runner, lines } = setup(async () => "Ciao!");
    await runner(baseTurn({ logPrefix: "[p] ", principal: verified("u1"), opening: true, text: "" }), baseSink());
    expect(lines[0]).toBe("[p] [turn] start (opening)");
  });
});

// #240: a model stopped sending mid-reasoning and the turn hung for good,
// holding the conversation's lock: no answer, no error. A streaming turn with
// no event from the model for the stall timeout is stopped with an error.
describe("createTurnRunner: stall watchdog", () => {
  type Timer = { fn: () => void; ms: number; cancelled: boolean };

  function setup(opts: {
    stallTimeoutMs?: number;
    run: (deps: Parameters<NonNullable<Parameters<typeof createTurnRunner>[0]["runTurnFn"]>>[2], timers: Timer[]) => Promise<string>;
    tools?: (onToolStart: TurnSink["onToolStart"], onToolFinish: TurnSink["onToolFinish"]) => void;
  }) {
    const timers: Timer[] = [];
    const lines: string[] = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: (_s, _k, _w, onToolStart, onToolFinish) => (opts.tools?.(onToolStart!, onToolFinish), {}),
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      logTurnFn: (line) => lines.push(line),
      heartbeat: () => () => {},
      ...(opts.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: opts.stallTimeoutMs }),
      stallTimer: (fn, ms) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return () => (timer.cancelled = true);
      },
      runTurnFn: async (_h, _t, deps) => opts.run(deps, timers),
    });
    return { runner, timers, lines };
  }

  /** The timer armed last and still live. */
  const live = (timers: Timer[]) => timers.filter((t) => !t.cancelled);

  /** A model call that hangs until it's aborted, as a stalled stream does. */
  const hangs = (signal: AbortSignal | undefined) =>
    new Promise<string>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));

  const streaming = () => baseSink({ onTextChunk: () => {}, onReasoningChunk: () => {} });

  test("stops a turn whose model sends nothing, with an error naming the timeout, and logs it", async () => {
    const { runner, timers, lines } = setup({
      stallTimeoutMs: 120_000,
      run: (deps, t) => {
        queueMicrotask(() => live(t)[0]!.fn());
        return hangs(deps.abortSignal);
      },
    });
    const sink = streaming();
    await expect(runner(baseTurn({ principal: verified("u1") }), sink)).rejects.toThrow("the model sent nothing for 120s");
    expect(timers[0]!.ms).toBe(120_000);
    expect(sink.disposed).toBe(true);
    expect(lines.at(-1)).toMatch(/\[turn\] stalled after [\d.]+s: the model sent nothing for 120s$/);
  });

  // Review of #240: the AI SDK doesn't throw when its signal aborts: the stream
  // ends with an "abort" part and the call returns what it had. A stall then
  // looked like a finished turn with half an answer, and no error at all.
  test("a stall still fails the turn when the model call returns what it had instead of throwing", async () => {
    const { runner, lines } = setup({
      stallTimeoutMs: 120_000,
      run: (deps, t) =>
        new Promise<string>((resolve) => {
          deps.abortSignal?.addEventListener("abort", () => resolve("Dante, in Purgatorio XXVI, 1"));
          queueMicrotask(() => live(t)[0]!.fn());
        }),
    });
    const sink = streaming();
    await expect(runner(baseTurn({ principal: verified("u1") }), sink)).rejects.toThrow("the model sent nothing for 120s");
    expect(sink.finalized).toEqual([]);
    expect(lines.at(-1)).toMatch(/\[turn\] stalled after [\d.]+s: the model sent nothing for 120s$/);
  });

  test("a client cancel that races a stall is reported as cancelled", async () => {
    const controller = new AbortController();
    const { runner, lines } = setup({
      stallTimeoutMs: 1000,
      run: (deps, t) => {
        queueMicrotask(() => {
          controller.abort();
          live(t)[0]?.fn();
        });
        return hangs(deps.abortSignal);
      },
    });
    await expect(runner(baseTurn({ principal: verified("u1"), abortSignal: controller.signal }), streaming())).rejects.toThrow("aborted");
    expect(lines.at(-1)).toMatch(/\[turn\] cancelled after/);
  });

  test("names a timeout under a minute with its decimals", async () => {
    const { runner } = setup({
      stallTimeoutMs: 1500,
      run: (deps, t) => {
        queueMicrotask(() => live(t)[0]!.fn());
        return hangs(deps.abortSignal);
      },
    });
    await expect(runner(baseTurn({ principal: verified("u1") }), streaming())).rejects.toThrow("the model sent nothing for 1.5s");
  });

  test("a stalled turn releases the conversation: the next turn runs", async () => {
    let calls = 0;
    const { runner } = setup({
      stallTimeoutMs: 1000,
      run: (deps, t) => {
        calls += 1;
        if (calls === 1) {
          queueMicrotask(() => live(t)[0]!.fn());
          return hangs(deps.abortSignal);
        }
        return Promise.resolve("ok");
      },
    });
    await expect(runner(baseTurn({ principal: verified("u1") }), streaming())).rejects.toThrow();
    const second = streaming();
    await runner(baseTurn({ principal: verified("u1") }), second);
    expect(second.finalized).toEqual(["ok"]);
  });

  test("every chunk and every finished step re-arms it", async () => {
    const { runner, timers } = setup({
      stallTimeoutMs: 1000,
      run: async (deps, t) => {
        expect(live(t)).toHaveLength(1);
        deps.onReasoningChunk!("a", "r1");
        deps.onTextChunk!("b");
        deps.onStepFinish!({ toolCalls: [], toolResults: [], content: [] } as unknown as StepInfo);
        expect(t).toHaveLength(4);
        expect(live(t)).toEqual([t[3]!]);
        return "ok";
      },
    });
    await runner(baseTurn({ principal: verified("u1") }), streaming());
    expect(live(timers)).toEqual([]); // stopped once the model is done
  });

  test("pauses while a tool runs, and starts again when it's done", async () => {
    let toolStart: TurnSink["onToolStart"] = () => {};
    let toolFinish: TurnSink["onToolFinish"] = () => {};
    const { runner } = setup({
      stallTimeoutMs: 1000,
      tools: (start, finish) => {
        toolStart = start;
        toolFinish = finish;
      },
      run: async (_deps, t) => {
        toolStart("jira", undefined, "c1");
        expect(live(t)).toEqual([]);
        toolFinish!("c1", "success");
        expect(live(t)).toHaveLength(1);
        return "ok";
      },
    });
    await runner(baseTurn({ principal: verified("u1") }), streaming());
  });

  test("is off with 0, without a timeout, and on a channel that doesn't stream", async () => {
    for (const [stallTimeoutMs, sink] of [
      [0, streaming()],
      [undefined, streaming()],
      [1000, baseSink()],
    ] as const) {
      const { runner, timers } = setup({ ...(stallTimeoutMs === undefined ? {} : { stallTimeoutMs }), run: async () => "ok" });
      await runner(baseTurn({ principal: verified("u1") }), sink);
      expect(timers).toEqual([]);
    }
  });

  test("a turn the client cancels is cancelled, not stalled", async () => {
    const controller = new AbortController();
    const { runner, lines } = setup({
      stallTimeoutMs: 1000,
      run: (deps) => {
        queueMicrotask(() => controller.abort());
        return hangs(deps.abortSignal);
      },
    });
    await expect(runner(baseTurn({ principal: verified("u1"), abortSignal: controller.signal }), streaming())).rejects.toThrow("aborted");
    expect(lines.at(-1)).toMatch(/\[turn\] cancelled after/);
  });
});

describe("parseStallTimeoutMs", () => {
  test("defaults to two minutes, takes a whole number of milliseconds, 0 turns it off", () => {
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(120_000);
    expect(parseStallTimeoutMs(undefined)).toBe(120_000);
    expect(parseStallTimeoutMs(" ")).toBe(120_000);
    expect(parseStallTimeoutMs(" 300000 ")).toBe(300_000);
    expect(parseStallTimeoutMs("0")).toBe(0);
  });

  test("refuses anything else, naming the variable", () => {
    for (const bad of ["-1", "1.5", "two minutes"]) {
      expect(() => parseStallTimeoutMs(bad)).toThrow(`TURN_STALL_TIMEOUT_MS must be a whole number of milliseconds from 0 up, got "${bad}"`);
    }
  });
});

describe("createTurnRunner: a turn resumed after a confirmation", () => {
  const resumed = {
    describe: "fetch https://example.org/a",
    label: "Solo questa volta",
    toolName: "web_fetch",
    input: { url: "https://example.org/a" },
    output: { title: "A", text: "the page body" },
  };

  function setup(slot: Map<string, typeof resumed>, guards: PostTurnGuard[] = []) {
    const calls: Array<{ text: string; resumed: unknown }> = [];
    const captured: Array<{ role: string; content: string }> = [];
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
      captureVerbatim: async (msg) => {
        captured.push({ role: msg.role, content: msg.content });
      },
      takeResumed: (sessionKey) => {
        const action = slot.get(sessionKey);
        slot.delete(sessionKey);
        return action;
      },
      postTurnGuards: guards,
      runTurnFn: async (_history, text, deps) => {
        calls.push({ text, resumed: deps.resumed });
        return "The page says hello.";
      },
    });
    return { runner, calls, captured };
  }

  test("runs the model with the session's confirmed action and a line naming it, then empties the slot", async () => {
    const slot = new Map([["session-1", resumed]]);
    const { runner, calls } = setup(slot);
    const sink = baseSink();

    await runner(baseTurn({ text: "", resumeAfterConfirm: true, principal: verified("u1") }), sink);

    expect(calls).toEqual([{ text: RESUMED_LINE(resumed), resumed }]);
    expect(RESUMED_LINE(resumed)).toBe("[Confirmed by the person: fetch https://example.org/a (Solo questa volta)]");
    expect(sink.finalized).toEqual(["The page says hello."]);
    expect(slot.size).toBe(0);
  });

  test("with nothing kept for the session, ends the turn with no answer and no model call", async () => {
    const { runner, calls } = setup(new Map([["other-session", resumed]]));
    const sink = baseSink();

    await runner(baseTurn({ text: "", resumeAfterConfirm: true }), sink);

    expect(calls).toEqual([]);
    expect(sink.finalized).toEqual([""]);
    expect(sink.disposed).toBe(true);
  });

  test("a guard's shouldRun sees the turn's steps too, the confirmed action first", async () => {
    const seen: StepInfo[][] = [];
    const guard: PostTurnGuard = {
      statusLabel: () => "g",
      statusId: "g",
      shouldRun: (_text, steps) => {
        seen.push(steps ?? []);
        return false;
      },
      run: async (text) => ({ text, outcome: "success" }),
    };
    const { runner } = setup(new Map([["session-1", resumed]]), [guard]);

    await runner(baseTurn({ text: "", resumeAfterConfirm: true }), baseSink());

    expect(seen[0]?.[0]?.toolCalls[0]?.toolName).toBe("web_fetch");
  });

  test("the post-turn guards see the confirmed action as the turn's first step", async () => {
    const seen: StepInfo[][] = [];
    const guard: PostTurnGuard = {
      statusLabel: () => "g",
      statusId: "g",
      shouldRun: () => true,
      run: async (text, steps) => {
        seen.push(steps);
        return { text, outcome: "success" };
      },
    };
    const { runner } = setup(new Map([["session-1", resumed]]), [guard]);

    await runner(baseTurn({ text: "", resumeAfterConfirm: true }), baseSink());

    expect(seen[0]?.[0]).toEqual({
      toolCalls: [{ toolCallId: expect.any(String), toolName: "web_fetch", input: { url: "https://example.org/a" } }],
      toolResults: [{ toolCallId: seen[0]?.[0]?.toolCalls[0]?.toolCallId ?? "", toolName: "web_fetch", output: { title: "A", text: "the page body" } }],
      content: [],
    });
  });

  test("the verbatim archive keeps the answer only: the line isn't something the person said", async () => {
    const { runner, captured } = setup(new Map([["session-1", resumed]]));

    await runner(baseTurn({ text: "", resumeAfterConfirm: true, principal: verified("u1") }), baseSink());

    expect(captured).toEqual([{ role: "assistant", content: "The page says hello." }]);
  });

  // Cold review of #235: in a shared space the multi-user prompt lets the model
  // answer NO_REPLY to a line nobody addressed to it, and the kept result was
  // already taken: the confirmed page was lost with no answer.
  test("a resumed turn in a shared space runs on the one-to-one prompt: it's always addressed to the assistant", async () => {
    const systems: string[] = [];
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
      takeResumed: () => resumed,
      runTurnFn: async (_h, _t, deps) => {
        systems.push(deps.system);
        return "ok";
      },
    });

    await runner(baseTurn({ text: "", multiUser: true, resumeAfterConfirm: true }), baseSink());

    expect(systems[0]?.startsWith("single")).toBe(true);
  });
});

// #281: the turn's texts follow the language the channel hints at (when the
// person saved none), and the stand-in for an answer the model didn't write
// reaches the channel as such, not as text it has to recognize.
describe("createTurnRunner: the turn's language and the pending note", () => {
  const NOTE_KEY = "core.pending.note";

  function setup(opts: { text?: string; displays?: string[]; guard?: PostTurnGuard } = {}) {
    const calls = {
      identify: [] as unknown[][],
      buildTools: [] as unknown[],
      translatorFor: [] as unknown[][],
      pendingNote: [] as unknown[],
      finalize: [] as unknown[][],
    };
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "s", multiUser: "m" },
      identify: async (principal, hint) => {
        calls.identify.push([principal.id, hint]);
        return { ok: true, operator: false, person: { key: `k:${principal.id}`, roles: [] } };
      },
      buildTools: (_sessionKey, _key, _who, _start, _finish, hint) => {
        calls.buildTools.push(hint);
        return {};
      },
      translatorFor: (key, hint) => {
        calls.translatorFor.push([key, hint]);
        return (k) => `${hint ?? "-"}:${k}`;
      },
      getOrCreateHistory: () => fakeHistory(),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      takeSurfacedDisplays: () => opts.displays ?? [],
      runTurnFn: async (_history, _input, deps) => {
        calls.pendingNote.push(deps.pendingNote);
        if (opts.text !== undefined) return opts.text;
        deps.onPendingNote?.();
        return deps.pendingNote!;
      },
      ...(opts.guard ? { postTurnGuards: [opts.guard] } : {}),
    });
    const sink = baseSink({
      finalize: async (text, info) => {
        calls.finalize.push(info === undefined ? [text] : [text, info]);
      },
    });
    return { runner, sink, calls };
  }

  test("the channel's hint reaches whom the turn is for, the tools and the turn's texts", async () => {
    const { runner, sink, calls } = setup({ text: "answer" });
    await runner(baseTurn({ principal: verified("u1"), languageHint: "it-IT" }), sink);
    expect(calls.identify).toEqual([["u1", "it-IT"]]);
    expect(calls.buildTools).toEqual(["it-IT"]);
    expect(calls.translatorFor).toEqual([["k:u1", "it-IT"]]);
  });

  test("the model gets the note in the turn's language, and the channel is told the text is it", async () => {
    const { runner, sink, calls } = setup();
    await runner(baseTurn({ principal: verified("u1"), languageHint: "it" }), sink);
    expect(calls.pendingNote).toEqual([`it:${NOTE_KEY}`]);
    expect(calls.finalize).toEqual([[`it:${NOTE_KEY}`, { pendingNote: `it:${NOTE_KEY}` }]]);
  });

  test("a list surfaced after the note still says where the text begins", async () => {
    const { runner, sink, calls } = setup({ displays: ["MER-1 Title"] });
    await runner(baseTurn({ principal: verified("u1") }), sink);
    expect(calls.finalize).toEqual([[`-:${NOTE_KEY}\n\nMER-1 Title`, { pendingNote: `-:${NOTE_KEY}` }]]);
  });

  // Review of #281: the runner recognized the note by comparing the turn's
  // text with it, so a guard that added to it lost the signal and the
  // channels showed the note next to their own confirmation.
  test("the note is said even after a guard added to it, and a model's text equal to it isn't one", async () => {
    const appending: PostTurnGuard = {
      statusLabel: () => "g",
      statusId: "g",
      shouldRun: () => true,
      run: async (text) => ({ text: `${text}\n\nSources: x`, outcome: "success" }),
    };
    const guarded = setup({ guard: appending });
    await guarded.runner(baseTurn({ principal: verified("u1") }), guarded.sink);
    expect(guarded.calls.finalize).toEqual([[`-:${NOTE_KEY}\n\nSources: x`, { pendingNote: `-:${NOTE_KEY}` }]]);

    const mimic = setup({ text: `-:${NOTE_KEY}` });
    await mimic.runner(baseTurn({ principal: verified("u1") }), mimic.sink);
    expect(mimic.calls.finalize).toEqual([[`-:${NOTE_KEY}`]]);
  });

  test("an answer the model wrote says nothing more", async () => {
    const { runner, sink, calls } = setup({ text: "answer" });
    await runner(baseTurn({ principal: verified("u1") }), sink);
    expect(calls.finalize).toEqual([["answer"]]);
  });
});

// #293: the model doesn't know what day it is unless the turn says.
describe("createTurnRunner: the turn's time", () => {
  // 2026-10-21T12:32:00Z, a Wednesday: 14:32 in Rome.
  const NOON = Date.parse("2026-10-21T12:32:00Z");

  function setup(opts: { stamp?: boolean; saved?: Record<string, string> } = {}) {
    const calls: string[] = [];
    const captured: Array<{ role: string; content: string }> = [];
    const asked: Array<{ key: string; hint: string | undefined }> = [];
    const histories: Array<string | undefined> = [];
    const runner = createTurnRunner({
      model: {} as any,
      systemPrompts: { singleUser: "single", multiUser: "multi" },
      buildTools: () => ({}),
      getOrCreateHistory: (_sessionKey, _tracked, _key, _resume, timeZone) => (histories.push(timeZone), fakeHistory()),
      trackSession: () => {},
      registerCaptureCallback: () => {},
      maybeCapture: async () => {},
      processToolCorrections: async () => {},
      logStep: () => {},
      logTurnFn: () => {},
      now: () => NOON,
      captureVerbatim: async (msg) => {
        captured.push({ role: msg.role, content: msg.content });
      },
      takeResumed: () => ({ describe: "fetch a page", toolName: "web_fetch", input: {}, output: {} }),
      ...(opts.stamp === false
        ? {}
        : {
            timeZoneFor: (key: string, hint: string | undefined) => {
              asked.push({ key, hint });
              return opts.saved?.[key] ?? hint ?? "Europe/Rome";
            },
          }),
      runTurnFn: async (_history, text) => {
        calls.push(text);
        return "reply";
      },
    });
    return { runner, calls, captured, asked, histories };
  }

  test("the model reads the message after when and where it was written; the archive keeps the message alone", async () => {
    const { runner, calls, captured } = setup();
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(calls).toEqual(["[Wednesday 2026-10-21 14:32 Europe/Rome]\nhello"]);
    expect(captured).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ]);
  });

  test("the zone is the person's, asked with the channel's hint", async () => {
    const { runner, calls, asked } = setup({ saved: { "google-chat:u1": "Asia/Tokyo" } });
    await runner(baseTurn({ principal: verified("u1"), timeZoneHint: "America/New_York" }), baseSink());
    await runner(baseTurn({ principal: verified("u2"), timeZoneHint: "America/New_York" }), baseSink());
    expect(asked).toEqual([
      { key: "google-chat:u1", hint: "America/New_York" },
      { key: "google-chat:u2", hint: "America/New_York" },
    ]);
    expect(calls).toEqual(["[Wednesday 2026-10-21 21:32 Asia/Tokyo]\nhello", "[Wednesday 2026-10-21 08:32 America/New_York]\nhello"]);
  });

  test("a shared space stamps each message in its sender's zone", async () => {
    const { runner, calls } = setup({ saved: { "google-chat:u1": "Asia/Tokyo" } });
    await runner(baseTurn({ principal: verified("u1"), multiUser: true }), baseSink());
    expect(calls).toEqual(["[Wednesday 2026-10-21 21:32 Asia/Tokyo]\nhello"]);
  });

  test("an opening and a resumed turn are stamped too", async () => {
    const { runner, calls } = setup();
    await runner(baseTurn({ principal: verified("u1"), opening: true, text: "" }), baseSink());
    await runner(baseTurn({ principal: verified("u1"), text: "", resumeAfterConfirm: true }), baseSink());
    expect(calls).toEqual([
      `[Wednesday 2026-10-21 14:32 Europe/Rome]\n${OPENING_CUE}`,
      `[Wednesday 2026-10-21 14:32 Europe/Rome]\n${RESUMED_LINE({ describe: "fetch a page", toolName: "web_fetch", input: {}, output: {} })}`,
    ]);
  });

  test("a resumed conversation's history is rebuilt in the turn's zone, for a person the channel vouched for", async () => {
    const { runner, histories } = setup({ saved: { "google-chat:u1": "Asia/Tokyo" } });
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    await runner(baseTurn({ principal: anonymous("u2"), timeZoneHint: "America/New_York" }), baseSink());
    expect(histories).toEqual(["Asia/Tokyo", undefined]);
  });

  test("without a zone to stamp in, the message goes as it is", async () => {
    const { runner, calls } = setup({ stamp: false });
    await runner(baseTurn({ principal: verified("u1") }), baseSink());
    expect(calls).toEqual(["hello"]);
  });
});
