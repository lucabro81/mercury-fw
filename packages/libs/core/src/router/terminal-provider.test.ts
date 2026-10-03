import { describe, expect, test } from "bun:test";
import { createTerminalProvider } from "./terminal-provider.ts";
import { startTerminalRepl } from "./terminal.ts";
import type { HandleTurn, InboundTurn } from "./provider.ts";
import { PENDING_CONFIRMATION_NOTE } from "../session/agent-turn.ts";

type CapturedHandleInput = (
  input: string,
  onChunk: (chunk: string, opts?: { aside?: boolean }) => void,
) => Promise<string>;

function fakeConfirmDeps() {
  return {
    store: {} as any,
    vaultPath: "/vault",
    writeConfirmationNoteFn: (async () => {}) as any,
  };
}

describe("createTerminalProvider", () => {
  test("/dump short-circuits without calling handleTurn", async () => {
    let capturedHandleInput!: CapturedHandleInput;
    let handleTurnCalled = false;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
    });

    const handleTurn: HandleTurn = async () => {
      handleTurnCalled = true;
    };
    await provider.start(handleTurn);

    const result = await capturedHandleInput("/dump", () => {});
    expect(handleTurnCalled).toBe(false);
    expect(result).toContain("wrote 0 tool step(s)");
  });

  test("a bare confirmation token short-circuits without calling handleTurn", async () => {
    let capturedHandleInput!: CapturedHandleInput;
    let handleTurnCalled = false;
    let tryConfirmArgs: unknown[] = [];

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async (input, sessionKey, deps) => {
        tryConfirmArgs = [input, sessionKey, deps.userId];
        return "Confermato ed eseguito.";
      },
    });

    const handleTurn: HandleTurn = async () => {
      handleTurnCalled = true;
    };
    await provider.start(handleTurn);

    const result = await capturedHandleInput("ABC123", () => {});
    expect(handleTurnCalled).toBe(false);
    expect(result).toBe("Confermato ed eseguito.");
    expect(tryConfirmArgs).toEqual(["ABC123", "terminal", "terminal"]);
  });

  // #131: /dump after a confirmation still wrote the turn before it, so an
  // e2e test read that turn's calls as the confirmation's.
  test("a confirmation is a turn of its own: /dump after it writes no steps", async () => {
    let capturedHandleInput!: CapturedHandleInput;
    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async (input) => (input === "ABC123" ? "Confermato ed eseguito." : null),
    });
    await provider.start(async (_turn, sink) => {
      sink.onStep?.({ toolCalls: [], toolResults: [], content: [] });
      await sink.finalize("staged");
    });

    await capturedHandleInput("delete SUP-1", () => {});
    expect(await capturedHandleInput("/dump", () => {})).toContain("wrote 1 tool step(s)");
    await capturedHandleInput("ABC123", () => {});
    expect(await capturedHandleInput("/dump", () => {})).toContain("wrote 0 tool step(s)");
  });

  test("a normal message calls handleTurn and returns the sink's finalized text", async () => {
    let capturedHandleInput!: CapturedHandleInput;
    let capturedTurn!: InboundTurn;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (turn, sink) => {
      capturedTurn = turn;
      await sink.finalize("the final answer");
    };
    await provider.start(handleTurn);

    const result = await capturedHandleInput("hello mercury", () => {});
    expect(result).toBe("the final answer");
    expect(capturedTurn).toEqual({
      channel: "terminal",
      multiUser: false,
      text: "hello mercury",
      sessionKey: "terminal",
      principal: { id: "terminal", provider: "none" },
      logPrefix: "",
    });
  });

  test("the sink's onToolStart writes the dim/italic ANSI sequence via onChunk", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onToolStart("sto leggendo jira...");
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => chunks.push(chunk));
    expect(chunks).toEqual(["\x1b[2m\x1b[3msto leggendo jira...\x1b[0m\n"]);
  });

  // Since cli-tool.ts stopped dictating "reply `conferma <token>`" to the
  // model (that's channel-specific now), the terminal must tell the user
  // itself, from the structured step data — not rely on the model's own
  // text to mention it.
  test("a confirm-required step prints the token instruction itself, not relying on the model's text", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onStep?.({
        toolCalls: [{ toolCallId: "1", toolName: "runCommand", input: { command: "jira issue delete KAN-1 --confirm" } }],
        toolResults: [{ toolCallId: "1", toolName: "runCommand", output: { ok: false, pendingConfirmation: true, token: "TOK1", summary: "jira issue delete KAN-1 --confirm" } }],
        content: [],
      });
      await sink.finalize("Questa azione richiede conferma.");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("elimina KAN-1", (chunk) => chunks.push(chunk));
    expect(chunks.join("")).toContain("jira issue delete KAN-1 --confirm");
    expect(chunks.join("")).toContain("scrivi: TOK1");
  });

  test("the sink's onTextChunk is the terminal's real onChunk (streaming enabled)", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onTextChunk?.("partial ");
      sink.onTextChunk?.("answer");
      await sink.finalize("partial answer");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => chunks.push(chunk));
    expect(chunks).toEqual(["partial ", "answer"]);
  });

  // agent-turn.ts streams PENDING_CONFIRMATION_NOTE via onTextChunk when a
  // turn stopped for a pending confirmation (see pendingConfirmationStop)
  // — but the sink's own onStep already printed the specific instruction
  // (command + token) for that same step. Printing the generic note too
  // would be a redundant second line saying nothing new.
  test("does not forward PENDING_CONFIRMATION_NOTE via onTextChunk — the onStep instruction already covers it", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onTextChunk?.(PENDING_CONFIRMATION_NOTE);
      await sink.finalize(PENDING_CONFIRMATION_NOTE);
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("elimina KAN-1", (chunk) => chunks.push(chunk));
    expect(chunks).toEqual([]);
  });

  // Regression (#61): everything the terminal printed counted as streamed
  // answer text, so the answer alone (the returned string) never extended it
  // and the REPL reprinted it under its correction marker. Only the answer
  // text may go through onChunk without `aside`.
  test("reasoning, tool labels and the confirmation line are aside chunks, the answer text isn't", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("penso", "block-1");
      sink.onReasoningEnd?.("block-1", false);
      sink.onToolStart("Sto leggendo dati con jira…");
      sink.onStep?.({
        toolCalls: [{ toolCallId: "1", toolName: "runCommand", input: { command: "jira issue delete KAN-1 --confirm" } }],
        toolResults: [{ toolCallId: "1", toolName: "runCommand", output: { ok: false, pendingConfirmation: true, token: "TOK1", summary: "jira issue delete KAN-1 --confirm" } }],
        content: [],
      });
      sink.onTextChunk?.("Ecco ");
      sink.onTextChunk?.("fatto.");
      await sink.finalize("Ecco fatto.");
    };
    await provider.start(handleTurn);

    const chunks: Array<{ chunk: string; aside: boolean }> = [];
    const result = await capturedHandleInput("hi", (chunk, opts) => chunks.push({ chunk, aside: opts?.aside === true }));
    expect(chunks).toEqual([
      { chunk: "\x1b[2m\x1b[3mSto pensando…\x1b[0m\n", aside: true },
      { chunk: "\x1b[2m\x1b[3mpenso\x1b[0m", aside: true },
      { chunk: "\n", aside: true },
      { chunk: "\x1b[2m\x1b[3mSto leggendo dati con jira…\x1b[0m\n", aside: true },
      { chunk: "Azione in sospeso: `jira issue delete KAN-1 --confirm` — scrivi: TOK1\n", aside: true },
      { chunk: "Ecco ", aside: false },
      { chunk: "fatto.", aside: false },
    ]);
    expect(result).toBe("Ecco fatto.");
  });

  // Same bug (#61), the empty-text case: a turn that stops on a staged
  // command with no text of its own finalizes PENDING_CONFIRMATION_NOTE,
  // whose chunk is dropped above. Returning it would now print it as the
  // unstreamed suffix, right after the specific instruction it repeats.
  test("returns an empty answer when the turn's text is only PENDING_CONFIRMATION_NOTE", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onTextChunk?.(PENDING_CONFIRMATION_NOTE);
      await sink.finalize(PENDING_CONFIRMATION_NOTE);
    };
    await provider.start(handleTurn);

    expect(await capturedHandleInput("elimina KAN-1", () => {})).toBe("");
  });

  // Same bug (#61), with a display the model surfaced via `present`: the
  // turn-runner appends it after the note (`note\n\ndisplay`), so the note
  // must go from the front of the answer, not only when it's all of it.
  test("drops PENDING_CONFIRMATION_NOTE from the front of the answer when a surfaced display follows it", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onTextChunk?.(PENDING_CONFIRMATION_NOTE);
      await sink.finalize(`${PENDING_CONFIRMATION_NOTE}\n\nMER-1 · In corso · Titolo`);
    };
    await provider.start(handleTurn);

    expect(await capturedHandleInput("elimina KAN-1", () => {})).toBe("MER-1 · In corso · Titolo");
  });

  // Regression (#61), end to end: the provider wired into the real REPL loop.
  // A turn that reasons and calls a tool before answering used to print the
  // answer a second time under the correction marker.
  test("in the real REPL, a turn with reasoning and a tool call prints its answer once, with no marker", async () => {
    const written: string[] = [];
    async function* oneLine() {
      yield "hi";
    }

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: (handleInput, _io, opts) =>
        startTerminalRepl(handleInput, { input: oneLine(), output: { write: (s) => written.push(s) } }, opts),
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("penso", "block-1");
      sink.onReasoningEnd?.("block-1", false);
      sink.onToolStart("Sto leggendo dati con jira…");
      sink.onTextChunk?.("Template DVD ");
      sink.onTextChunk?.("non si apre");
      await sink.finalize("Template DVD non si apre");
    };
    await provider.start(handleTurn);

    const out = written.join("");
    expect(out).not.toContain("risposta corretta");
    expect(out.split("Template DVD non si apre").length - 1).toBe(1);
  });

  test("the first onReasoningChunk prints a dim 'Sto pensando…' header before the chunk itself", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("primo pezzo", "block-1");
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => chunks.push(chunk));
    expect(chunks).toEqual(["\x1b[2m\x1b[3mSto pensando…\x1b[0m\n", "\x1b[2m\x1b[3mprimo pezzo\x1b[0m"]);
  });

  test("subsequent onReasoningChunk calls in the same turn don't reprint the header", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("uno", "block-1");
      sink.onReasoningChunk?.("due", "block-1");
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => chunks.push(chunk));
    expect(chunks).toEqual([
      "\x1b[2m\x1b[3mSto pensando…\x1b[0m\n",
      "\x1b[2m\x1b[3muno\x1b[0m",
      "\x1b[2m\x1b[3mdue\x1b[0m",
    ]);
  });

  // The reported scenario: reasoning, a tool call, then reasoning again in
  // the same turn — two distinct SDK ids, not a continuation of the first.
  test("a second reasoning block (different id) in the same turn gets its own header", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("primo", "block-1");
      sink.onReasoningEnd?.("block-1", false);
      sink.onToolStart("Sto leggendo dati con jira…");
      sink.onReasoningChunk?.("secondo", "block-2");
      sink.onReasoningEnd?.("block-2", false);
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => chunks.push(chunk));
    expect(chunks).toEqual([
      "\x1b[2m\x1b[3mSto pensando…\x1b[0m\n",
      "\x1b[2m\x1b[3mprimo\x1b[0m",
      "\n",
      "\x1b[2m\x1b[3mSto leggendo dati con jira…\x1b[0m\n",
      "\x1b[2m\x1b[3mSto pensando…\x1b[0m\n",
      "\x1b[2m\x1b[3msecondo\x1b[0m",
      "\n",
    ]);
  });

  test("onReasoningEnd prints a trailing newline once reasoning happened this turn", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("x", "block-1");
      sink.onReasoningEnd?.("block-1", false);
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => chunks.push(chunk));
    expect(chunks.at(-1)).toBe("\n");
  });

  // Covers the non-reasoning-model case for the terminal specifically: if
  // the model never produced any reasoning this turn, onReasoningEnd must
  // still be safe to call (agent-turn.ts never actually calls it in that
  // case, but the sink shouldn't assume that invariant either) and must
  // print nothing at all.
  test("onReasoningEnd with no prior onReasoningChunk this turn prints nothing", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningEnd?.("block-1", false);
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    const chunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => chunks.push(chunk));
    expect(chunks).toEqual([]);
  });

  test("a fresh turn's sink reprints the header, even if a previous turn already printed it", async () => {
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 4096,
      startTerminalReplFn: async (handleInput) => {
        capturedHandleInput = handleInput;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("x", "block-1");
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    const firstTurnChunks: string[] = [];
    await capturedHandleInput("hi", (chunk) => firstTurnChunks.push(chunk));
    const secondTurnChunks: string[] = [];
    await capturedHandleInput("hi again", (chunk) => secondTurnChunks.push(chunk));

    expect(firstTurnChunks[0]).toBe("\x1b[2m\x1b[3mSto pensando…\x1b[0m\n");
    expect(secondTurnChunks[0]).toBe("\x1b[2m\x1b[3mSto pensando…\x1b[0m\n");
  });

  test("usage reported via the sink feeds the prompt suffix", async () => {
    let capturedPromptSuffix!: () => string;
    let capturedHandleInput!: CapturedHandleInput;

    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      getLoadedContextLengthFn: async () => 8000,
      startTerminalReplFn: async (handleInput, _io, opts) => {
        capturedHandleInput = handleInput;
        capturedPromptSuffix = opts!.promptSuffix!;
      },
      tryConfirmFn: async () => null,
    });

    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onUsage?.(2000);
      await sink.finalize("done");
    };
    await provider.start(handleTurn);

    expect(capturedPromptSuffix()).toContain("?k");

    await capturedHandleInput("hi", () => {});
    expect(capturedPromptSuffix()).toBe("[~2k/~8k tokens] ");
  });

  test("notify writes to stderr and returns the terminal session key", async () => {
    const written: string[] = [];
    const provider = createTerminalProvider({
      confirmDeps: fakeConfirmDeps(),
      ollamaHost: "http://host",
      ollamaModel: "model",
      stderrWrite: (s) => written.push(s),
    });

    const result = await provider.notify("some-user", "hello there");
    expect(result).toEqual({ sessionKey: "terminal" });
    expect(written).toEqual(["[notify] to some-user: hello there"]);
  });
});
