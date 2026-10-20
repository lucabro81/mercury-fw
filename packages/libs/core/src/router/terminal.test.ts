import { describe, it, expect } from "bun:test";
import { startTerminalRepl, PROMPT } from "./terminal.ts";

function fakeOutput() {
  const lines: string[] = [];
  const calls: Array<{ text: string; newline: boolean }> = [];
  return {
    lines,
    calls,
    write: (s: string, opts?: { newline?: boolean }) => {
      lines.push(s);
      calls.push({ text: s, newline: opts?.newline !== false });
    },
  };
}

async function* oneLine(line: string): AsyncIterable<string> {
  yield line;
}

async function* manyLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}

describe("startTerminalRepl", () => {
  it("writes a prompt before the first input and after each result, so it's clear when an answer is done", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string) => input.toUpperCase();

    await startTerminalRepl(handleInput, { input: oneLine("hello"), output });

    expect(output.lines).toEqual([PROMPT, "HELLO", PROMPT]);
  });

  // Regression: PROMPT was written through the same path as every other
  // line, which on the real terminal always appends "\n" — so input
  // landed one line below "> " instead of right after it.
  it("writes the prompt without a trailing newline, so input continues on the same line", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string) => `echo: ${input}`;

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    const promptCalls = output.calls.filter((c) => c.text === PROMPT);
    expect(promptCalls.length).toBeGreaterThan(0);
    expect(promptCalls.every((c) => c.newline === false)).toBe(true);

    const resultCall = output.calls.find((c) => c.text === "echo: hi");
    expect(resultCall?.newline).toBe(true);
  });

  it("writes handleInput's result for each input line, then returns on EOF", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string) => input.toUpperCase();

    await startTerminalRepl(handleInput, { input: oneLine("hello"), output });

    expect(output.lines).toContain("HELLO");
  });

  it("processes multiple lines in order, with a prompt between each", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string) => `echo: ${input}`;

    await startTerminalRepl(handleInput, {
      input: manyLines(["a", "b", "c"]),
      output,
    });

    expect(output.lines).toEqual([
      PROMPT,
      "echo: a",
      PROMPT,
      "echo: b",
      PROMPT,
      "echo: c",
      PROMPT,
    ]);
  });

  it("writes an error line and keeps going when handleInput rejects, instead of crashing", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string) => {
      if (input === "bad") {
        throw new Error("boom");
      }
      return `ok: ${input}`;
    };

    await startTerminalRepl(handleInput, {
      input: manyLines(["good-before", "bad", "good-after"]),
      output,
    });

    const results = output.lines.filter((l) => l !== PROMPT);
    expect(results[0]).toBe("ok: good-before");
    expect(results[1]).toContain("boom");
    expect(results[2]).toBe("ok: good-after");
  });

  // The terminal-side half of streaming: handleInput receives an onChunk
  // it can call as text arrives, so the REPL doesn't sit silent for the
  // several seconds a full local-model response can take.
  it("writes each chunk as handleInput emits it via onChunk, then a closing newline and the next prompt", async () => {
    const output = fakeOutput();
    const handleInput = async (_input: string, onChunk: (chunk: string) => void) => {
      onChunk("Hel");
      onChunk("lo");
      return "Hello";
    };

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    expect(output.calls).toEqual([
      { text: PROMPT, newline: false },
      { text: "Hel", newline: false },
      { text: "lo", newline: false },
      { text: "", newline: true },
      { text: PROMPT, newline: false },
    ]);
  });

  it("doesn't duplicate output: when handleInput never calls onChunk, the returned result is written once", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string, _onChunk: (chunk: string) => void) =>
      `echo: ${input}`;

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    expect(output.lines).toEqual([PROMPT, "echo: hi", PROMPT]);
  });

  // Regression: turn-runner.ts can append text after generation finishes
  // (a deterministic display the model surfaced via `present`, see
  // display-store.ts) — that appended text was never streamed via
  // onChunk, so it must still reach the terminal instead of being silently
  // dropped by the old "streamed ⇒ write nothing more" assumption.
  it("writes the part of the result that wasn't streamed, when handleInput appends more after streaming", async () => {
    const output = fakeOutput();
    const handleInput = async (_input: string, onChunk: (chunk: string) => void) => {
      onChunk("Hel");
      onChunk("lo");
      return "Hello\n\nMER-1\nhttps://x";
    };

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    expect(output.calls).toEqual([
      { text: PROMPT, newline: false },
      { text: "Hel", newline: false },
      { text: "lo", newline: false },
      { text: "\n\nMER-1\nhttps://x", newline: true },
      { text: PROMPT, newline: false },
    ]);
  });

  // A plugin's post-turn guard (turn-runner.ts) can REPLACE the model's text
  // after it was streamed, not just append to it: the result no longer
  // extends what was already streamed, so slicing off streamedText.length
  // would be meaningless. The already-streamed text can't be un-printed, so
  // the real final answer is shown in full instead, clearly marked.
  it("the correction marker is the one it's given, in the person's language", async () => {
    const output = fakeOutput();
    const handleInput = async (_input: string, onChunk: (chunk: string) => void) => {
      onChunk("Ciao");
      return "Salve";
    };

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output }, { correctedNote: () => "[risposta corretta]" });

    expect(output.calls).toContainEqual({ text: "\n\n[risposta corretta]\n\nSalve", newline: true });
  });

  it("writes the full result with a correction marker, when it no longer extends what was streamed", async () => {
    const output = fakeOutput();
    const handleInput = async (_input: string, onChunk: (chunk: string) => void) => {
      onChunk("Hel");
      onChunk("lo, here are the tickets: MER-1, MER-2");
      return "Ecco i risultati.\n\nMER-1\nhttps://x";
    };

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    expect(output.calls).toEqual([
      { text: PROMPT, newline: false },
      { text: "Hel", newline: false },
      { text: "lo, here are the tickets: MER-1, MER-2", newline: false },
      {
        text: "\n\n[answer corrected from what was shown above]\n\nEcco i risultati.\n\nMER-1\nhttps://x",
        newline: true,
      },
      { text: PROMPT, newline: false },
    ]);
  });

  // Regression (#61): reasoning, tool labels and the pending-confirmation
  // line were counted as streamed answer text, so the result (the answer
  // alone) never extended it and every turn that reasoned or called a tool
  // reprinted the whole answer under the correction marker.
  it("leaves aside chunks out of the comparison: a streamed answer after reasoning is printed once, with no marker", async () => {
    const output = fakeOutput();
    const handleInput = async (
      _input: string,
      onChunk: (chunk: string, opts?: { aside?: boolean }) => void,
    ) => {
      onChunk("Sto pensando…\n", { aside: true });
      onChunk("the user wants a greeting", { aside: true });
      onChunk("Hel");
      onChunk("cerca issue\n", { aside: true });
      onChunk("lo");
      return "Hello";
    };

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    expect(output.calls).toEqual([
      { text: PROMPT, newline: false },
      { text: "Sto pensando…\n", newline: false },
      { text: "the user wants a greeting", newline: false },
      { text: "Hel", newline: false },
      { text: "cerca issue\n", newline: false },
      { text: "lo", newline: false },
      { text: "", newline: true },
      { text: PROMPT, newline: false },
    ]);
  });

  // Same bug (#61), the append case: a `present` display after an answer
  // that followed reasoning must come out as the suffix alone.
  it("writes only the unstreamed suffix when aside chunks preceded the answer", async () => {
    const output = fakeOutput();
    const handleInput = async (
      _input: string,
      onChunk: (chunk: string, opts?: { aside?: boolean }) => void,
    ) => {
      onChunk("thinking", { aside: true });
      onChunk("Hello");
      return "Hello\n\nMER-1";
    };

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    expect(output.calls).toEqual([
      { text: PROMPT, newline: false },
      { text: "thinking", newline: false },
      { text: "Hello", newline: false },
      { text: "\n\nMER-1", newline: true },
      { text: PROMPT, newline: false },
    ]);
  });

  it("ends the streamed line before printing an error, when handleInput streams then rejects", async () => {
    const output = fakeOutput();
    const handleInput = async (_input: string, onChunk: (chunk: string) => void) => {
      onChunk("partial");
      throw new Error("boom");
    };

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    const texts = output.calls.map((c) => c.text);
    expect(texts[0]).toBe(PROMPT);
    expect(texts[1]).toBe("partial");
    expect(texts[2]).toBe("");
    expect(texts[3]).toContain("boom");
    expect(texts[4]).toBe(PROMPT);
  });

  // Lets the caller show a live indicator (e.g. context usage, see
  // src/router/tool-log.ts's formatContextUsage) right before "> ",
  // recomputed each time since the value it reports changes turn to turn.
  // Regression: the suffix was written with the default newline, landing
  // on its own line above "> " instead of right next to it.
  it("writes the result of promptSuffix() right before every prompt, on the same line, recomputing it each time", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string) => `echo: ${input}`;
    let counter = 0;
    const promptSuffix = () => `[call ${++counter}] `;

    await startTerminalRepl(
      handleInput,
      { input: manyLines(["a", "b"]), output },
      { promptSuffix },
    );

    expect(output.lines).toEqual([
      "[call 1] ",
      PROMPT,
      "echo: a",
      "[call 2] ",
      PROMPT,
      "echo: b",
      "[call 3] ",
      PROMPT,
    ]);
    const suffixCalls = output.calls.filter((c) => c.text.startsWith("[call"));
    expect(suffixCalls.every((c) => c.newline === false)).toBe(true);
  });

  it("writes no suffix at all when promptSuffix is omitted", async () => {
    const output = fakeOutput();
    const handleInput = async (input: string) => `echo: ${input}`;

    await startTerminalRepl(handleInput, { input: oneLine("hi"), output });

    expect(output.lines).toEqual([PROMPT, "echo: hi", PROMPT]);
  });
});
