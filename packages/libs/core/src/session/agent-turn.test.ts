import { describe, it, expect } from "bun:test";
import { runTurn, buildGenerateTextParams, buildStreamTextParams, ABORTED_MARKER } from "./agent-turn.ts";
import { CORE_MESSAGES } from "../i18n/core-messages.ts";
import { HISTORY_CALL_NOTE, SKILL_CALL_NOTE } from "./call-record.ts";

/** The stand-in for an answer the model didn't write, in English. */
const PENDING_CONFIRMATION_NOTE = CORE_MESSAGES["core.pending.note"]!;
import { keptHistory } from "./__fixtures__/kept-history.ts";
import type { ModelMessage, Tool } from "ai";
import type { StepInfo } from "./step-info.ts";

/** A step that staged a confirm-required command — see pending-confirmation.ts. */
const PENDING_CONFIRMATION_STEP: StepInfo = {
  toolCalls: [{ toolCallId: "1", toolName: "runCommand", input: { command: "jira issue delete KAN-1" } }],
  toolResults: [{ toolCallId: "1", toolName: "runCommand", output: { pendingConfirmation: true, token: "TOK1" } }],
  content: [],
};

/** Mirrors the AI SDK's own `isStopConditionMet`: true if *any* condition in the array is true (confirmed against `node_modules/ai/dist/index.js`'s `.some(result => result)`). */
async function stopConditionsMet(stopWhen: unknown, steps: unknown[]): Promise<boolean> {
  const conditions = stopWhen as Array<(opts: { steps: unknown[] }) => Promise<boolean> | boolean>;
  return (await Promise.all(conditions.map((c) => c({ steps })))).some(Boolean);
}

/** Wraps plain text chunks as a fake `fullStream`'s `text-delta` parts — the shape `runTurn` actually reads today (it no longer consumes `textStream`). */
async function* textDeltaStream(chunks: string[]) {
  for (const chunk of chunks) {
    yield { type: "text-delta" as const, id: "1", delta: chunk };
  }
}

const SYSTEM = "you are a test assistant";

describe("runTurn", () => {
  it("adds the user input to history before generating", async () => {
    const history = keptHistory();
    let messagesAtGenerateTime: ModelMessage[] = [];
    const generateTextFn = async (params: { messages: ModelMessage[] }) => {
      messagesAtGenerateTime = params.messages;
      return { text: "ok" };
    };

    await runTurn(history, "hello", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
    });

    expect(messagesAtGenerateTime).toEqual([{ role: "user", content: "hello" }]);
  });

  it("returns exactly the text produced by the fake generator", async () => {
    const history = keptHistory();
    const generateTextFn = async () => ({ text: "fixed response" });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
    });

    expect(result).toBe("fixed response");
  });

  it("forwards deps.abortSignal to the non-streaming generator (turn cancellation)", async () => {
    const history = keptHistory();
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const generateTextFn = async (params: { abortSignal?: AbortSignal }) => {
      seen = params.abortSignal;
      return { text: "ok" };
    };
    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
      abortSignal: ac.signal,
    });
    expect(seen).toBe(ac.signal);
  });

  it("forwards deps.abortSignal to the streaming generator (turn cancellation)", async () => {
    const history = keptHistory();
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const streamTextFn = async (params: { abortSignal?: AbortSignal }) => {
      seen = params.abortSignal;
      return { stream: textDeltaStream(["hi"]), usage: Promise.resolve({ inputTokens: 1 }) };
    };
    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
      abortSignal: ac.signal,
    });
    expect(seen).toBe(ac.signal);
  });

  it("adds the assistant's response to history after generating", async () => {
    const history = keptHistory();
    const generateTextFn = async () => ({ text: "fixed response" });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
    });

    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "fixed response" },
    ]);
  });

  it("passes the provided tools through to the generation call", async () => {
    const history = keptHistory();
    const fakeTool = {} as Tool;
    let receivedTools: Record<string, Tool> | undefined;
    const generateTextFn = async (params: { tools: Record<string, Tool> }) => {
      receivedTools = params.tools;
      return { text: "ok" };
    };

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: { jiraCli: fakeTool },
      system: SYSTEM,
      generateTextFn,
    });

    expect(receivedTools).toEqual({ jiraCli: fakeTool });
  });

  it("passes the provided system prompt through to the generation call unchanged", async () => {
    const history = keptHistory();
    let receivedSystem: string | undefined;
    const generateTextFn = async (params: { instructions: string }) => {
      receivedSystem = params.instructions;
      return { text: "ok" };
    };

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
    });

    expect(receivedSystem).toBe(SYSTEM);
  });

  // The terminal channel uses this to print tool calls as they happen,
  // since otherwise there's no visibility into what Mercury did before
  // producing a final answer — see src/router/terminal.ts. runTurn wraps
  // the caller's callback (to track the last step for
  // resolveEmptyText/pendingConfirmationStop), so identity isn't
  // preserved — only that a step reaching the wrapper reaches the
  // original too.
  it("forwards each step to the caller's onStepFinish when provided, on the generation path", async () => {
    const history = keptHistory();
    const ordinaryStep: StepInfo = { toolCalls: [], toolResults: [], content: [] };
    const receivedSteps: StepInfo[] = [];
    const generateTextFn = async (params: { onStepEnd?: (step: StepInfo) => void }) => {
      params.onStepEnd?.(ordinaryStep);
      return { text: "ok" };
    };

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
      onStepFinish: (step) => receivedSteps.push(step),
    });

    expect(receivedSteps).toEqual([ordinaryStep]);
  });

  // The terminal channel uses onTextChunk to print Mercury's answer as it
  // arrives instead of waiting for the whole thing — see
  // src/router/terminal.ts. Google Chat never sets onTextChunk, so it
  // keeps using the generateTextFn path above unchanged.
  it("streams chunks via onTextChunk and returns the full joined text, when onTextChunk is provided", async () => {
    const history = keptHistory();
    const received: string[] = [];
    const streamTextFn = async () => ({ stream: textDeltaStream(["Hel", "lo, ", "world"]) });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: (chunk) => received.push(chunk),
    });

    expect(received).toEqual(["Hel", "lo, ", "world"]);
    expect(result).toBe("Hello, world");
  });

  it("records the full joined streamed text as the assistant's message", async () => {
    const history = keptHistory();
    const streamTextFn = async () => ({ stream: textDeltaStream(["foo", "bar"]) });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
    });

    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "foobar" },
    ]);
  });

  it("forwards each step to the caller's onStepFinish when provided, on the streaming path too", async () => {
    const history = keptHistory();
    const ordinaryStep: StepInfo = { toolCalls: [], toolResults: [], content: [] };
    const receivedSteps: StepInfo[] = [];
    const streamTextFn = async (params: { onStepEnd?: (step: StepInfo) => void }) => {
      params.onStepEnd?.(ordinaryStep);
      return { stream: textDeltaStream([]) };
    };

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
      onStepFinish: (step) => receivedSteps.push(step),
    });

    expect(receivedSteps).toEqual([ordinaryStep]);
  });

  it("calls onReasoningChunk once per reasoning-delta part, in order, with the right delta and the SDK's own reasoning-block id", async () => {
    async function* fakeStream() {
      yield { type: "reasoning-delta", id: "block-1", delta: "Let me " };
      yield { type: "reasoning-delta", id: "block-1", delta: "think." };
      yield { type: "reasoning-end", id: "block-1" };
    }
    const history = keptHistory();
    const received: Array<[string, string]> = [];
    const streamTextFn = async () => ({ stream: fakeStream() });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onReasoningChunk: (chunk, id) => received.push([chunk, id]),
    });

    expect(received).toEqual([
      ["Let me ", "block-1"],
      ["think.", "block-1"],
    ]);
  });

  // The hard requirement: reasoning is a live UI-only surface, never fed
  // back to the model on a later turn. Asserted by searching for absence,
  // not just equality against an expected value — guards against a future
  // refactor accidentally merging the two accumulators.
  it("never lets reasoning content reach the returned text or the recorded history entry", async () => {
    async function* fakeStream() {
      yield { type: "reasoning-delta", id: "1", delta: "secret reasoning" };
      yield { type: "reasoning-end", id: "1" };
      yield { type: "text-delta", id: "2", delta: "the real answer" };
    }
    const history = keptHistory();
    const streamTextFn = async () => ({ stream: fakeStream() });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
      onReasoningChunk: () => {},
    });

    expect(result).toBe("the real answer");
    expect(result).not.toContain("secret reasoning");
    const historyText = history.getMessages().map((m) => m.content).join("\n");
    expect(historyText).not.toContain("secret reasoning");
  });

  it("calls onReasoningEnd exactly once, with the block's id and failed:false, when a reasoning-end part arrives normally", async () => {
    async function* fakeStream() {
      yield { type: "reasoning-delta", id: "block-1", delta: "x" };
      yield { type: "reasoning-end", id: "block-1" };
    }
    const history = keptHistory();
    const calls: Array<[string, boolean]> = [];
    const streamTextFn = async () => ({ stream: fakeStream() });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onReasoningChunk: () => {},
      onReasoningEnd: (id, failed) => calls.push([id, failed]),
    });

    expect(calls).toEqual([["block-1", false]]);
  });

  it("still calls onReasoningEnd exactly once, with the block's id and failed:true, and still propagates the error, when the stream throws right after a reasoning-delta with no reasoning-end", async () => {
    async function* fakeStream() {
      yield { type: "reasoning-delta", id: "block-1", delta: "x" };
      throw new Error("stream broke");
    }
    const history = keptHistory();
    const calls: Array<[string, boolean]> = [];
    const streamTextFn = async () => ({ stream: fakeStream() });

    await expect(
      runTurn(history, "hi", {
        model: "fake-model" as never,
        tools: {},
        system: SYSTEM,
        streamTextFn,
        onReasoningChunk: () => {},
        onReasoningEnd: (id, failed) => calls.push([id, failed]),
      }),
    ).rejects.toThrow("stream broke");

    expect(calls).toEqual([["block-1", true]]);
  });

  // The user's actual reported scenario: a tool-calling turn can reason,
  // call a tool, then reason again about the result before answering — two
  // independent reasoning blocks with two different SDK ids, not one
  // continuous burst. Each must close on its own; the second must not be
  // mistaken for a continuation of the first.
  it("closes each reasoning block independently when the model reasons twice in one turn (e.g. around a tool call)", async () => {
    async function* fakeStream() {
      yield { type: "reasoning-delta", id: "block-1", delta: "first thought" };
      yield { type: "reasoning-end", id: "block-1" };
      yield { type: "reasoning-delta", id: "block-2", delta: "second thought" };
      yield { type: "reasoning-end", id: "block-2" };
      yield { type: "text-delta", id: "t", delta: "answer" };
    }
    const history = keptHistory();
    const chunks: Array<[string, string]> = [];
    const ends: Array<[string, boolean]> = [];
    const streamTextFn = async () => ({ stream: fakeStream() });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
      onReasoningChunk: (chunk, id) => chunks.push([chunk, id]),
      onReasoningEnd: (id, failed) => ends.push([id, failed]),
    });

    expect(chunks).toEqual([
      ["first thought", "block-1"],
      ["second thought", "block-2"],
    ]);
    expect(ends).toEqual([
      ["block-1", false],
      ["block-2", false],
    ]);
  });

  it("never calls onReasoningEnd when no reasoning-delta ever arrived", async () => {
    const history = keptHistory();
    let calls = 0;
    const streamTextFn = async () => ({ stream: textDeltaStream(["just an answer"]) });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
      onReasoningEnd: () => {
        calls++;
      },
    });

    expect(calls).toBe(0);
  });

  it("selects the streaming path when only onReasoningChunk is provided (no onTextChunk)", async () => {
    const history = keptHistory();
    let streamTextFnCalled = false;
    const streamTextFn = async () => {
      streamTextFnCalled = true;
      return { stream: textDeltaStream(["answer"]) };
    };
    const generateTextFn = async () => {
      throw new Error("should not take the generateText path");
    };

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      generateTextFn,
      onReasoningChunk: () => {},
    });

    expect(streamTextFnCalled).toBe(true);
  });

  // Mirrors the real Ollama sequencing guarantee: reasoning always fully
  // completes before any answer text begins.
  it("delivers reasoning chunks and onReasoningEnd strictly before the first onTextChunk, on an interleaved stream", async () => {
    async function* fakeStream() {
      yield { type: "reasoning-delta", id: "1", delta: "r1" };
      yield { type: "reasoning-delta", id: "1", delta: "r2" };
      yield { type: "reasoning-end", id: "1" };
      yield { type: "text-delta", id: "2", delta: "t1" };
      yield { type: "text-delta", id: "2", delta: "t2" };
      yield { type: "text-end", id: "2" };
    }
    const history = keptHistory();
    const events: string[] = [];
    const streamTextFn = async () => ({ stream: fakeStream() });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: (c) => events.push(`text:${c}`),
      onReasoningChunk: (c) => events.push(`reasoning:${c}`),
      onReasoningEnd: () => events.push("reasoning-end"),
    });

    expect(events).toEqual(["reasoning:r1", "reasoning:r2", "reasoning-end", "text:t1", "text:t2"]);
    expect(result).toBe("t1t2");
  });

  // Regression: `ai`'s own .d.ts declares text-delta/reasoning-delta parts
  // twice with different field names for the same `type` value (`delta`
  // in one place, `text` in another — node_modules/ai/dist/index.d.ts:
  // 2103-2107 vs 2555-2558). The installed ai-sdk-ollama version actually
  // emits `text`, confirmed live: the real reasoning/answer content came
  // through as `{"type":"reasoning-delta","id":"...","text":"The"}`, not
  // `delta`. Reading only `part.delta` (the original implementation)
  // silently extracted `undefined` for every chunk, so both the reasoning
  // card and the final answer itself stayed empty for the whole turn —
  // this is the bug behind "il modello sembra non rispondere" reported
  // live: the answer wasn't missing, it was being read as "" every time.
  it("still extracts chunk content when the real part shape uses 'text' instead of 'delta' (both text-delta and reasoning-delta)", async () => {
    async function* fakeStream() {
      yield { type: "reasoning-delta", id: "1", text: "sto pensando" };
      yield { type: "reasoning-end", id: "1" };
      yield { type: "text-delta", id: "2", text: "la risposta vera" };
    }
    const history = keptHistory();
    const reasoningChunks: string[] = [];
    const streamTextFn = async () => ({ stream: fakeStream() });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
      onReasoningChunk: (c) => reasoningChunks.push(c),
    });

    expect(reasoningChunks).toEqual(["sto pensando"]);
    expect(result).toBe("la risposta vera");
  });

  // The terminal channel shows this next to the prompt as a real (not
  // estimated) context-usage indicator — see src/router/tool-log.ts's
  // formatContextUsage and src/index.ts's wiring.
  it("passes the real inputTokens from usage to onUsage, on the generateText path", async () => {
    const history = keptHistory();
    let receivedInputTokens: number | undefined;
    const generateTextFn = async () => ({
      text: "ok",
      usage: { inputTokens: 1234 },
    });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
      onUsage: (inputTokens) => {
        receivedInputTokens = inputTokens;
      },
    });

    expect(receivedInputTokens).toBe(1234);
  });

  it("passes the real inputTokens from usage to onUsage, on the streaming path", async () => {
    const history = keptHistory();
    let receivedInputTokens: number | undefined;
    const streamTextFn = async () => ({
      stream: textDeltaStream(["ok"]),
      usage: Promise.resolve({ inputTokens: 5678 }),
    });

    await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
      onUsage: (inputTokens) => {
        receivedInputTokens = inputTokens;
      },
    });

    expect(receivedInputTokens).toBe(5678);
  });

  // Regression: observed live — a turn that spent its entire tool-call
  // budget on retries (e.g. jira's required --select, guessed wrong a
  // couple of times) can reach the model's step limit with no step left
  // to actually write an answer. streamText then resolves with a
  // fullStream that yields nothing at all: no error, no chunk. Left
  // empty on purpose (no fallback message) — silence in this genuinely-
  // stuck case is an accepted tradeoff, not solved here (see
  // resolveHistoryText's doc comment in agent-turn.ts).
  it("leaves the streamed answer empty, and sends nothing via onTextChunk, when it's genuinely empty", async () => {
    const history = keptHistory();
    const received: string[] = [];
    // yields nothing — the model ran out of steps before writing text
    const streamTextFn = async () => ({ stream: textDeltaStream([]) });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: (chunk) => received.push(chunk),
    });

    expect(received).toEqual([]);
    expect(result).toBe("");
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
    ]);
  });

  it("treats a whitespace-only streamed answer the same as an empty one", async () => {
    const history = keptHistory();
    const streamTextFn = async () => ({ stream: textDeltaStream(["   \n"]) });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
    });

    expect(result).toBe("");
  });

  it("does not touch a non-empty streamed answer", async () => {
    const history = keptHistory();
    const streamTextFn = async () => ({ stream: textDeltaStream(["a real answer"]) });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: () => {},
    });

    expect(result).toBe("a real answer");
  });

  // Same regression, non-streaming path (currently unused in production —
  // both real channels always set onTextChunk — but kept correct since
  // it's still a public, directly tested code path.
  it("leaves the text empty when generateText returns empty text and the last step wasn't a pending confirmation", async () => {
    const history = keptHistory();
    const generateTextFn = async () => ({ text: "" });

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
    });

    expect(result).toBe("");
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
    ]);
  });

  // The actual point of stopping the loop early on a pending confirmation
  // (see buildGenerateTextParams/buildStreamTextParams below): the model
  // never gets a step to write anything after staging the command, so
  // there's nothing to substitute a fallback for except this fixed,
  // non-model-generated note — never the token, never model prose. The
  // user-visible text stays this fixed note (unchanged — both channels
  // already suppress it, showing their own UI instead: a card on Google
  // Chat, a printed instruction on the terminal), but what actually lands
  // in SessionHistory is the opaque `[REQ:<token>]` marker, not this
  // sentence — see the next describe block for why: this exact sentence,
  // once summarized into persistent memory, told a brand-new session after
  // a restart that an action was permanently "still pending", long after it
  // had actually been confirmed or abandoned (tokens don't survive a
  // restart, or even 5 minutes — see confirmation-store.ts's TTL).
  it("records PENDING_CONFIRMATION_NOTE instead of leaving it empty when the last step staged a confirm-required command (non-streaming)", async () => {
    const history = keptHistory();
    const generateTextFn = async (params: { onStepEnd?: (step: StepInfo) => void }) => {
      params.onStepEnd?.(PENDING_CONFIRMATION_STEP);
      return { text: "" };
    };

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
    });

    expect(result).toBe(PENDING_CONFIRMATION_NOTE);
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "[REQ:TOK1]" },
    ]);
  });

  it("records PENDING_CONFIRMATION_NOTE instead of leaving it empty when the last step staged a confirm-required command (streaming)", async () => {
    const history = keptHistory();
    const received: string[] = [];
    const streamTextFn = async (params: { onStepEnd?: (step: StepInfo) => void }) => {
      params.onStepEnd?.(PENDING_CONFIRMATION_STEP);
      return { stream: textDeltaStream([]) };
    };

    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn,
      onTextChunk: (chunk) => received.push(chunk),
    });

    // #281: the note isn't streamed: it would read as the model's words; the
    // channel learns about it from the turn's end.
    expect(received).toEqual([]);
    expect(result).toBe(PENDING_CONFIRMATION_NOTE);
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "[REQ:TOK1]" },
    ]);
  });

  it("stands in with the note the turn hands it, in the person's language", async () => {
    const history = keptHistory();
    const generateTextFn = async (params: { onStepEnd?: (step: StepInfo) => void }) => {
      params.onStepEnd?.(PENDING_CONFIRMATION_STEP);
      return { text: "" };
    };
    const result = await runTurn(history, "ciao", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn,
      pendingNote: "Azione in attesa di conferma.",
    });
    expect(result).toBe("Azione in attesa di conferma.");
  });

  it("says when it stood in with the note, and only then", async () => {
    const generateTextFn = (text: string) => async (params: { onStepEnd?: (step: StepInfo) => void }) => {
      params.onStepEnd?.(PENDING_CONFIRMATION_STEP);
      return { text };
    };
    const told: string[] = [];
    for (const text of ["", "I staged it."]) {
      await runTurn(keptHistory(), "hi", {
        model: "fake-model" as never,
        tools: {},
        system: SYSTEM,
        generateTextFn: generateTextFn(text),
        onPendingNote: () => told.push(text),
      });
    }
    expect(told).toEqual([""]);
  });

  // Regression guard for the stale-primer bug: the opaque marker recorded
  // into history must be the token, not the generic sentence — it's the
  // thing that gets fed into episodic summarization later, and a fixed
  // sentence about "still pending" is exactly what caused the bug (an LLM
  // summarizer had no way to know it had already been resolved by the time
  // anyone read the summary back).
  describe("SessionHistory records an opaque [REQ:<token>] marker, not PENDING_CONFIRMATION_NOTE", () => {
    it("uses the real token from the step that staged the confirm-required command", async () => {
      const history = keptHistory();
      const step: StepInfo = {
        toolCalls: [{ toolCallId: "1", toolName: "runCommand", input: { command: "jira issue delete KAN-9" } }],
        toolResults: [{ toolCallId: "1", toolName: "runCommand", output: { pendingConfirmation: true, token: "OTHER9" } }],
        content: [],
      };
      const generateTextFn = async (params: { onStepEnd?: (step: StepInfo) => void }) => {
        params.onStepEnd?.(step);
        return { text: "" };
      };

      await runTurn(history, "elimina KAN-9", {
        model: "fake-model" as never,
        tools: {},
        system: SYSTEM,
        generateTextFn,
      });

      expect(history.getMessages()).toEqual([
        { role: "user", content: "elimina KAN-9" },
        { role: "assistant", content: "[REQ:OTHER9]" },
      ]);
    });
  });
});

describe("buildGenerateTextParams", () => {
  // Regression test: generateText's stopWhen defaults to stepCountIs(1),
  // meaning it stops after a single step. If the model's first step is a
  // tool call (no accompanying text), generateText never gets a second
  // step to synthesize a final answer from the tool result — text comes
  // back empty. Observed for real: asking Mercury a Jira question made it
  // call jiraCli and return an empty string, with no error anywhere.
  //
  // The cap was raised from an original 5: observed live, a conversation
  // combining wiki lookups with a jira search (which always needs
  // --select, so almost always costs 2 attempts) routinely spent all 5
  // steps on tool calls alone, leaving zero steps for the model to ever
  // write an answer. First raised to 20 (matching this SDK's own default
  // for its higher-level agent construct, see ai/dist/index.d.ts's
  // ToolLoopAgentSettings), then to 100 for extra headroom during this
  // research phase — the model should be free to make as many tool calls
  // as it needs, not be cut off by an arbitrary ceiling.
  it("configures a step cap of 100, so tool-heavy turns aren't cut off before the model gets to answer", async () => {
    const params = buildGenerateTextParams({
      model: "fake-model" as never,
      messages: [],
      tools: {},
      instructions: SYSTEM,
    });

    const ordinaryStep: StepInfo = { toolCalls: [], toolResults: [], content: [] };
    const stopped = async (n: number) => stopConditionsMet(params.stopWhen, new Array(n).fill(ordinaryStep));
    expect(await stopped(99)).toBe(false);
    expect(await stopped(100)).toBe(true);
  });

  // The actual reason a second stop condition exists alongside the step
  // cap: a confirm-required command must stop the loop immediately,
  // regardless of how many steps are left in the budget — see
  // resolveHistoryText's doc comment for why.
  it("stops immediately when the last step staged a confirm-required command, regardless of step count", async () => {
    const params = buildGenerateTextParams({
      model: "fake-model" as never,
      messages: [],
      tools: {},
      instructions: SYSTEM,
    });

    expect(await stopConditionsMet(params.stopWhen, [PENDING_CONFIRMATION_STEP])).toBe(true);
  });
});

describe("buildStreamTextParams", () => {
  // Same regression as buildGenerateTextParams's, for the streaming path.
  it("configures a step cap of 100, so tool-heavy turns aren't cut off before the model gets to answer", async () => {
    const params = buildStreamTextParams({
      model: "fake-model" as never,
      messages: [],
      tools: {},
      instructions: SYSTEM,
    });

    const ordinaryStep: StepInfo = { toolCalls: [], toolResults: [], content: [] };
    const stopped = async (n: number) => stopConditionsMet(params.stopWhen, new Array(n).fill(ordinaryStep));
    expect(await stopped(99)).toBe(false);
    expect(await stopped(100)).toBe(true);
  });

  it("stops immediately when the last step staged a confirm-required command, regardless of step count", async () => {
    const params = buildStreamTextParams({
      model: "fake-model" as never,
      messages: [],
      tools: {},
      instructions: SYSTEM,
    });

    expect(await stopConditionsMet(params.stopWhen, [PENDING_CONFIRMATION_STEP])).toBe(true);
  });
});

// #243: a generation that ended on an error or a token limit looked exactly
// like a finished one, because the finish and error parts were dropped.
describe("runTurn reports how the generation ended", () => {
  it("passes the stream's final finish part reason to onFinish, once", async () => {
    async function* fakeStream() {
      yield { type: "text-delta", id: "1", text: "done" };
      yield { type: "finish-step", finishReason: "tool-calls" };
      yield { type: "finish", finishReason: "stop" };
    }
    const calls: Array<[string, string | undefined]> = [];
    await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn: async () => ({ stream: fakeStream() }),
      onTextChunk: () => {},
      onFinish: (reason, error) => calls.push([reason, error]),
    });
    expect(calls).toEqual([["stop", undefined]]);
  });

  it("passes an error part's message along with the error finish reason", async () => {
    async function* fakeStream() {
      yield { type: "text-delta", id: "1", text: "half an ans" };
      yield { type: "error", error: new Error("socket hang up") };
      yield { type: "finish", finishReason: "error" };
    }
    const calls: Array<[string, string | undefined]> = [];
    const text = await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn: async () => ({ stream: fakeStream() }),
      onTextChunk: () => {},
      onFinish: (reason, error) => calls.push([reason, error]),
    });
    expect(calls).toEqual([["error", "socket hang up"]]);
    expect(text).toBe("half an ans");
  });

  it("stringifies an error part whose error isn't an Error", async () => {
    async function* fakeStream() {
      yield { type: "error", error: "model unloaded" };
      yield { type: "finish", finishReason: "error" };
    }
    const calls: Array<[string, string | undefined]> = [];
    await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn: async () => ({ stream: fakeStream() }),
      onTextChunk: () => {},
      onFinish: (reason, error) => calls.push([reason, error]),
    });
    expect(calls).toEqual([["error", "model unloaded"]]);
  });

  it("doesn't call onFinish when the stream ends without a finish part (an abort)", async () => {
    async function* fakeStream() {
      yield { type: "text-delta", id: "1", text: "cut" };
      yield { type: "abort" };
    }
    let called = false;
    await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn: async () => ({ stream: fakeStream() }),
      onTextChunk: () => {},
      onFinish: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it("passes generateText's finishReason to onFinish on the non-streaming path", async () => {
    const calls: Array<[string, string | undefined]> = [];
    await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async () => ({ text: "ok", finishReason: "length" }),
      onFinish: (reason, error) => calls.push([reason, error]),
    });
    expect(calls).toEqual([["length", undefined]]);
  });

  it("doesn't call onFinish when generateText returns no finishReason", async () => {
    let called = false;
    await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async () => ({ text: "ok" }),
      onFinish: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});

describe("runTurn — resumed after a confirmation", () => {
  const resumed = {
    describe: "fetch https://example.org/a",
    label: "Solo questa volta",
    toolName: "web_fetch",
    input: { url: "https://example.org/a" },
    output: { title: "A", text: "the page body" },
  };

  /** What the model is handed after the history: the confirmed call and its result, in the tool role. */
  function expectResumedPair(messages: unknown[]) {
    const [call, result] = messages.slice(-2) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(call?.role).toBe("assistant");
    expect(call?.content).toEqual([{ type: "tool-call", toolCallId: expect.any(String), toolName: "web_fetch", input: { url: "https://example.org/a" } }]);
    expect(result?.role).toBe("tool");
    expect(result?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: call?.content[0]?.toolCallId,
        toolName: "web_fetch",
        output: { type: "json", value: { title: "A", text: "the page body" } },
      },
    ]);
  }

  it("hands the model the confirmed call and its result after the history, and keeps the result out of the history", async () => {
    const history = keptHistory();
    let seen: unknown[] = [];
    const generateTextFn = async (params: { messages: unknown[] }) => {
      seen = params.messages;
      return { text: "Here is what the page says." };
    };

    const text = await runTurn(history, "[Confermato: fetch https://example.org/a — Solo questa volta]", {
      model: {} as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: generateTextFn as never,
      resumed,
    });

    expect(text).toBe("Here is what the page says.");
    expect(seen[seen.length - 3]).toEqual({ role: "user", content: "[Confermato: fetch https://example.org/a — Solo questa volta]" });
    expectResumedPair(seen);
    // The confirmed call stays, reduced: what it ran and how it went, not the page.
    expect(history.getMessages()).toEqual([
      { role: "user", content: "[Confermato: fetch https://example.org/a — Solo questa volta]" },
      {
        role: "assistant",
        content: "Here is what the page says.",
        calls: [{ toolName: "web_fetch", input: { url: "https://example.org/a" }, result: { ok: true, ran: '{"url":"https://example.org/a"}' } }],
      },
    ]);
  });

  it("does the same on the streaming path", async () => {
    const history = keptHistory();
    let seen: unknown[] = [];
    const streamTextFn = async (params: { messages: unknown[] }) => {
      seen = params.messages;
      return { stream: textDeltaStream(["ok"]) };
    };

    await runTurn(history, "[Confermato]", {
      model: {} as never,
      tools: {},
      system: SYSTEM,
      onTextChunk: () => {},
      streamTextFn: streamTextFn as never,
      resumed,
    });

    expectResumedPair(seen);
  });

  it("a result that isn't JSON-shaped reaches the model as null rather than breaking the call", async () => {
    const history = keptHistory();
    let seen: unknown[] = [];
    const generateTextFn = async (params: { messages: unknown[] }) => {
      seen = params.messages;
      return { text: "ok" };
    };

    await runTurn(history, "[Confermato]", {
      model: {} as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: generateTextFn as never,
      resumed: { ...resumed, output: undefined },
    });

    const result = seen[seen.length - 1] as { content: Array<{ output: unknown }> };
    expect(result.content[0]?.output).toEqual({ type: "json", value: null });
  });
});

// Regression for #242: an aborted call (the person stopped it, or the stall
// watchdog fired) used to leave its half answer in the history, so the next
// turn saw an answer the person never received.
describe("runTurn — an aborted call", () => {
  it("records the aborted marker instead of the half answer, on the streaming path", async () => {
    const ac = new AbortController();
    async function* fakeStream() {
      yield { type: "text-delta", id: "1", text: "half an ans" };
      ac.abort();
      yield { type: "abort" };
    }
    const history = keptHistory();
    const text = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn: async () => ({ stream: fakeStream() }),
      onTextChunk: () => {},
      abortSignal: ac.signal,
    });
    expect(text).toBe("");
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: ABORTED_MARKER },
    ]);
  });

  it("records the aborted marker instead of the half answer, on the non-streaming path", async () => {
    const ac = new AbortController();
    const history = keptHistory();
    const text = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async () => {
        ac.abort();
        return { text: "half an ans" };
      },
      abortSignal: ac.signal,
    });
    expect(text).toBe("");
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: ABORTED_MARKER },
    ]);
  });

  it("records the marker, and still throws, when the aborted stream throws", async () => {
    const ac = new AbortController();
    async function* fakeStream() {
      yield { type: "text-delta", id: "1", text: "half" };
      ac.abort();
      throw new Error("aborted");
    }
    const history = keptHistory();
    await expect(
      runTurn(history, "hi", {
        model: "fake-model" as never,
        tools: {},
        system: SYSTEM,
        streamTextFn: async () => ({ stream: fakeStream() }),
        onTextChunk: () => {},
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(history.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: ABORTED_MARKER },
    ]);
  });

  it("leaves a stream that throws without an abort as it was", async () => {
    async function* fakeStream() {
      yield { type: "text-delta", id: "1", text: "half" };
      throw new Error("broken");
    }
    const history = keptHistory();
    await expect(
      runTurn(history, "hi", {
        model: "fake-model" as never,
        tools: {},
        system: SYSTEM,
        streamTextFn: async () => ({ stream: fakeStream() }),
        onTextChunk: () => {},
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("broken");
    expect(history.getMessages()).toEqual([{ role: "user", content: "hi" }]);
  });

  it("doesn't report the pending note for an aborted call", async () => {
    const ac = new AbortController();
    let noted = false;
    await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async (params: { onStepEnd?: (step: StepInfo) => void }) => {
        params.onStepEnd?.(PENDING_CONFIRMATION_STEP);
        ac.abort();
        return { text: "" };
      },
      abortSignal: ac.signal,
      onPendingNote: () => {
        noted = true;
      },
    });
    expect(noted).toBe(false);
  });
});

// A turn's tool calls stay in the history, and later turns get them back as
// real tool messages with reduced results: with plain-text answers only, the
// model stops calling tools and invents the data (#351, #352).
describe("runTurn — the turn's tool calls in the history", () => {
  const searchStep: StepInfo = {
    toolCalls: [{ toolCallId: "a", toolName: "confluenceCommand", input: { command: "confluence page search --cql 'text ~ \"docker\"'" } }],
    toolResults: [{ toolCallId: "a", toolName: "confluenceCommand", output: { ok: true, data: { results: [{ id: "1101" }] }, displayRef: "d1" } }],
    content: [],
  };
  const presentStep: StepInfo = {
    toolCalls: [{ toolCallId: "b", toolName: "present", input: { ref: "d1" } }],
    toolResults: [{ toolCallId: "b", toolName: "present", output: { ok: true } }],
    content: [],
  };
  const searchCall = {
    toolName: "confluenceCommand",
    input: { command: "confluence page search --cql 'text ~ \"docker\"'" },
    result: { ok: true, ran: "confluence page search --cql 'text ~ \"docker\"'", results: 1, displayRef: "d1" },
  };
  const presentCall = { toolName: "present", input: { ref: "d1" }, result: { ok: true, ran: '{"ref":"d1"}' } };

  /** A non-streaming generator that runs `steps`, then answers `text`, and keeps the messages it was handed. */
  function generating(steps: StepInfo[], text: string, seen?: { messages: ModelMessage[] }) {
    return async (params: { messages: ModelMessage[]; onStepEnd?: (step: StepInfo) => void }) => {
      if (seen) seen.messages = params.messages;
      for (const step of steps) params.onStepEnd?.(step);
      return { text };
    };
  }

  it("records the calls of every step, in order, with the answer (non-streaming)", async () => {
    const history = keptHistory();
    await runTurn(history, "docker pages?", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: generating([searchStep, presentStep], "One page."),
    });
    expect(history.getMessages()).toEqual([
      { role: "user", content: "docker pages?" },
      { role: "assistant", content: "One page.", calls: [searchCall, presentCall] },
    ]);
  });

  it("records them on the streaming path too", async () => {
    const history = keptHistory();
    await runTurn(history, "docker pages?", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn: async (params: { onStepEnd?: (step: StepInfo) => void }) => {
        params.onStepEnd?.(searchStep);
        params.onStepEnd?.(presentStep);
        return { stream: textDeltaStream(["One ", "page."]) };
      },
      onTextChunk: () => {},
    });
    expect(history.getMessages()[1]).toEqual({ role: "assistant", content: "One page.", calls: [searchCall, presentCall] });
  });

  it("hands later turns each past answer's calls as tool calls and reduced results, before its text, ids unique", async () => {
    const history = keptHistory();
    const deps = { model: "fake-model" as never, tools: {}, system: SYSTEM };
    await runTurn(history, "docker pages?", { ...deps, generateTextFn: generating([searchStep], "One page.") });
    await runTurn(history, "show it", { ...deps, generateTextFn: generating([presentStep], "Here.") });
    const seen = { messages: [] as ModelMessage[] };
    await runTurn(history, "thanks", { ...deps, generateTextFn: generating([], "You're welcome.", seen) });

    expect(seen.messages).toEqual([
      { role: "user", content: "docker pages?" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "history-1-0", toolName: "confluenceCommand", input: searchCall.input }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "history-1-0",
            toolName: "confluenceCommand",
            output: { type: "json", value: { ...searchCall.result, note: HISTORY_CALL_NOTE } },
          },
        ],
      },
      { role: "assistant", content: "One page." },
      { role: "user", content: "show it" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "history-3-0", toolName: "present", input: { ref: "d1" } }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "history-3-0", toolName: "present", output: { type: "json", value: { ...presentCall.result, note: HISTORY_CALL_NOTE } } },
        ],
      },
      { role: "assistant", content: "Here." },
      { role: "user", content: "thanks" },
    ]);
  });

  // A skill read in an earlier turn isn't loaded anymore: the model must be told
  // so, or it guesses the skill's commands instead of reading it again (#356).
  it("hands a later turn an earlier read_skill with the note that the skill must be read again", async () => {
    const history = keptHistory();
    const deps = { model: "fake-model" as never, tools: {}, system: SYSTEM };
    const skillStep: StepInfo = {
      toolCalls: [{ toolCallId: "s", toolName: "read_skill", input: { name: "confluence" } }],
      toolResults: [{ toolCallId: "s", toolName: "read_skill", output: { ok: true, data: "the skill" } }],
      content: [],
    };
    await runTurn(history, "docker pages?", { ...deps, generateTextFn: generating([skillStep, searchStep], "One page.") });
    const seen = { messages: [] as ModelMessage[] };
    await runTurn(history, "its comments?", { ...deps, generateTextFn: generating([], "None.", seen) });

    expect(seen.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "history-1-0",
          toolName: "read_skill",
          output: { type: "json", value: { ok: true, ran: '{"name":"confluence"}', note: SKILL_CALL_NOTE } },
        },
        {
          type: "tool-result",
          toolCallId: "history-1-1",
          toolName: "confluenceCommand",
          output: { type: "json", value: { ...searchCall.result, note: HISTORY_CALL_NOTE } },
        },
      ],
    });
  });

  it("hands a past answer without calls back as its text alone, with no calls field", async () => {
    const history = keptHistory();
    const deps = { model: "fake-model" as never, tools: {}, system: SYSTEM };
    await runTurn(history, "hi", { ...deps, generateTextFn: generating([], "Hello.") });
    const seen = { messages: [] as ModelMessage[] };
    await runTurn(history, "again", { ...deps, generateTextFn: generating([], "Hello again.", seen) });
    expect(seen.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "again" },
    ]);
  });

  it("records no calls for a turn that staged a confirmation: the resumed turn brings that call back", async () => {
    const history = keptHistory();
    await runTurn(history, "delete KAN-1", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: generating([searchStep, PENDING_CONFIRMATION_STEP], ""),
    });
    expect(history.getMessages()).toEqual([
      { role: "user", content: "delete KAN-1" },
      { role: "assistant", content: "[REQ:TOK1]" },
    ]);
  });

  it("records no calls for an aborted turn", async () => {
    const ac = new AbortController();
    const history = keptHistory();
    await runTurn(history, "docker pages?", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async (params: { onStepEnd?: (step: StepInfo) => void }) => {
        params.onStepEnd?.(searchStep);
        ac.abort();
        return { text: "half" };
      },
      abortSignal: ac.signal,
    });
    expect(history.getMessages()).toEqual([
      { role: "user", content: "docker pages?" },
      { role: "assistant", content: ABORTED_MARKER },
    ]);
  });

  it("records, for a resumed turn, the confirmed call first, then the turn's own", async () => {
    const history = keptHistory();
    await runTurn(history, "[Confermato: fetch https://example.org/a — Solo questa volta]", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: generating([presentStep], "Here is the page."),
      resumed: {
        describe: "fetch https://example.org/a",
        label: "Solo questa volta",
        toolName: "web_fetch",
        input: { url: "https://example.org/a" },
        output: { ok: true, title: "A", text: "the page body" },
      },
    });
    expect(history.getMessages()[1]).toEqual({
      role: "assistant",
      content: "Here is the page.",
      calls: [
        { toolName: "web_fetch", input: { url: "https://example.org/a" }, result: { ok: true, ran: '{"url":"https://example.org/a"}' } },
        presentCall,
      ],
    });
  });
});

// A tool's login request didn't end the turn: the person got the link, and
// the model went on calling other tools nobody asked for, burning context
// on an answer the person didn't want (observed live: a Confluence question
// answered from Jira while the Confluence login waited).
describe("a step asking for a login ends the turn", () => {
  const loginResult = (service: string) => ({
    ok: false,
    loginRequired: true,
    service,
    authorizeUrl: `https://login.example/${service}`,
    error: "The user isn't logged in yet",
  });
  const LOGIN_STEP: StepInfo = {
    toolCalls: [{ toolCallId: "c", toolName: "confluenceCommand", input: { command: "confluence page search" } }],
    toolResults: [{ toolCallId: "c", toolName: "confluenceCommand", output: loginResult("confluence") }],
    content: [],
  };
  const TWO_LOGINS_STEP: StepInfo = {
    toolCalls: [
      { toolCallId: "c", toolName: "confluenceCommand", input: { command: "confluence page search" } },
      { toolCallId: "j", toolName: "jiraCommand", input: { command: "jira issue list" } },
      { toolCallId: "b", toolName: "bitbucketCommand", input: { command: "bitbucket repo list" } },
    ],
    toolResults: [
      { toolCallId: "c", toolName: "confluenceCommand", output: loginResult("confluence") },
      { toolCallId: "j", toolName: "jiraCommand", output: { ok: true, data: [] } },
      { toolCallId: "b", toolName: "bitbucketCommand", output: loginResult("bitbucket") },
    ],
    content: [],
  };
  const LOGIN_NOTE = (services: string) => CORE_MESSAGES["core.login.note"]!.replace("{services}", services);
  const params = { model: "fake-model" as never, messages: [], tools: {}, instructions: SYSTEM };

  it("stops right after the step, on both paths", async () => {
    expect(await stopConditionsMet(buildGenerateTextParams(params).stopWhen, [LOGIN_STEP])).toBe(true);
    expect(await stopConditionsMet(buildStreamTextParams(params).stopWhen, [LOGIN_STEP])).toBe(true);
  });

  it("goes on when the login couldn't start: the model tells the person", async () => {
    const failed: StepInfo = {
      toolCalls: LOGIN_STEP.toolCalls,
      toolResults: [{ toolCallId: "c", toolName: "confluenceCommand", output: { ok: false, error: "The user isn't logged in to confluence, and their login couldn't start" } }],
      content: [],
    };
    expect(await stopConditionsMet(buildGenerateTextParams(params).stopWhen, [failed])).toBe(false);
    expect(await stopConditionsMet(buildStreamTextParams(params).stopWhen, [failed])).toBe(false);
  });

  it("answers with the note when the model wrote nothing, and keeps it and the calls in the history", async () => {
    const history = keptHistory();
    const result = await runTurn(history, "confluence pages on docker?", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async (p: { onStepEnd?: (step: StepInfo) => void }) => {
        p.onStepEnd?.(LOGIN_STEP);
        return { text: "" };
      },
    });
    expect(result).toBe(LOGIN_NOTE("confluence"));
    const [, answer] = history.getMessages();
    expect(answer?.content).toBe(LOGIN_NOTE("confluence"));
    expect(answer?.calls?.map((c) => c.toolName)).toEqual(["confluenceCommand"]);
  });

  it("puts the note after what the model streamed, without streaming it", async () => {
    const received: string[] = [];
    const result = await runTurn(keptHistory(), "confluence pages on docker?", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      streamTextFn: async (p: { onStepEnd?: (step: StepInfo) => void }) => {
        p.onStepEnd?.(LOGIN_STEP);
        return { stream: textDeltaStream(["Searching ", "Confluence."]) };
      },
      onTextChunk: (chunk) => received.push(chunk),
    });
    expect(received).toEqual(["Searching ", "Confluence."]);
    expect(result).toBe(`Searching Confluence.\n\n${LOGIN_NOTE("confluence")}`);
  });

  it("uses the note the turn hands it, with every service of the step in order", async () => {
    const asked: string[][] = [];
    const result = await runTurn(keptHistory(), "ciao", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async (p: { onStepEnd?: (step: StepInfo) => void }) => {
        p.onStepEnd?.(TWO_LOGINS_STEP);
        return { text: "" };
      },
      loginNote: (services) => {
        asked.push(services);
        return `Accedi a ${services.join(" e ")}, poi riscrivimi.`;
      },
    });
    expect(asked).toEqual([["confluence", "bitbucket"]]);
    expect(result).toBe("Accedi a confluence e bitbucket, poi riscrivimi.");
  });

  it("the English note names the services, comma-separated", async () => {
    const result = await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async (p: { onStepEnd?: (step: StepInfo) => void }) => {
        p.onStepEnd?.(TWO_LOGINS_STEP);
        return { text: "" };
      },
    });
    expect(result).toBe(LOGIN_NOTE("confluence, bitbucket"));
  });

  // Review of #368: an empty service name read "log in to  with…", and two
  // links to one service named it twice.
  it("names each service once, leaving out empty names, and says no name when none is left", async () => {
    const step = (...services: string[]): StepInfo => ({
      toolCalls: services.map((_, i) => ({ toolCallId: String(i), toolName: "t", input: {} })),
      toolResults: services.map((service, i) => ({
        toolCallId: String(i),
        toolName: "t",
        output: { ok: false, loginRequired: true, service, authorizeUrl: `https://login.example/${i}`, error: "e" },
      })),
      content: [],
    });
    const run = (s: StepInfo, loginNote?: (services: string[]) => string) =>
      runTurn(keptHistory(), "hi", {
        model: "fake-model" as never,
        tools: {},
        system: SYSTEM,
        generateTextFn: async (p: { onStepEnd?: (step: StepInfo) => void }) => {
          p.onStepEnd?.(s);
          return { text: "" };
        },
        ...(loginNote ? { loginNote } : {}),
      });
    const asked: string[][] = [];
    await run(step("jira", "", "jira"), (services) => {
      asked.push(services);
      return "n";
    });
    expect(asked).toEqual([["jira"]]);
    expect(await run(step(""))).toBe(CORE_MESSAGES["core.login.note-any"]!);
  });

  it("leaves a step that also staged a confirmation to the confirmation's handling", async () => {
    const both: StepInfo = {
      toolCalls: [...PENDING_CONFIRMATION_STEP.toolCalls, ...LOGIN_STEP.toolCalls],
      toolResults: [...PENDING_CONFIRMATION_STEP.toolResults, ...LOGIN_STEP.toolResults],
      content: [],
    };
    const history = keptHistory();
    const result = await runTurn(history, "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async (p: { onStepEnd?: (step: StepInfo) => void }) => {
        p.onStepEnd?.(both);
        return { text: "" };
      },
    });
    expect(result).toBe(PENDING_CONFIRMATION_NOTE);
    expect(history.getMessages()[1]?.content).toBe("[REQ:TOK1]");
  });

  it("leaves a turn with no login as the model wrote it", async () => {
    const result = await runTurn(keptHistory(), "hi", {
      model: "fake-model" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async () => ({ text: "Hello." }),
    });
    expect(result).toBe("Hello.");
  });
});

// #387: a `turn` context layer goes in front of the person's message, and
// stays there in what the model is sent on later turns: each call then starts
// with the previous one, whole, so the model's cache of it holds (taking it
// out again changed the middle of the prompt, and a model whose cache can only
// grow, a hybrid one, read the whole conversation again every turn). The
// history's text stays the message as the person wrote it.
describe("runTurn: the turn's context", () => {
  it("puts the turn's context in front of its message and keeps it there for the next calls, on both paths, the history's text without it", async () => {
    for (const streaming of [false, true]) {
      const history = keptHistory();
      await history.addUserMessage("earlier");
      await history.addAssistantMessage("answer");
      const sent: ModelMessage[][] = [];
      async function* fakeStream() {
        yield { type: "text-delta", id: "1", text: "ok" };
        yield { type: "finish", finishReason: "stop" };
      }
      const turn = (text: string, turnContext?: string) =>
        runTurn(history, text, {
          model: "fake-model" as never,
          tools: {},
          system: SYSTEM,
          ...(turnContext === undefined ? {} : { turnContext }),
          ...(streaming
            ? {
                streamTextFn: async (params: { messages: ModelMessage[] }) => (sent.push(params.messages), { stream: fakeStream() }),
                onTextChunk: () => {},
              }
            : { generateTextFn: async (params: { messages: ModelMessage[] }) => (sent.push(params.messages), { text: "ok" }) }),
        } as never);
      await turn("now", "<context>\nfact\n</context>");
      await turn("then", "<context>\nother\n</context>");
      await turn("last");
      expect(sent[0]).toEqual([
        { role: "user", content: "earlier" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "<context>\nfact\n</context>\n\nnow" },
      ]);
      expect(sent[1]).toEqual([...sent[0]!, { role: "assistant", content: "ok" }, { role: "user", content: "<context>\nother\n</context>\n\nthen" }]);
      expect(sent[2]).toEqual([...sent[1]!, { role: "assistant", content: "ok" }, { role: "user", content: "last" }]);
      expect(history.getMessages().map((m) => m.content)).toEqual(["earlier", "answer", "now", "ok", "then", "ok", "last", "ok"]);
    }
  });
});
