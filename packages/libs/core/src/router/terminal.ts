/**
 * The stdin/stdout REPL loop behind the dev console: it feeds whatever it reads
 * into a generic `handleInput` callback and writes back whatever that callback
 * returns.
 *
 * Why this exists: the dev REPL (`bun run repl`) is a debug/bootstrap console,
 * not a production channel — a single operator, identity-less, no memory
 * capture. This file is the *only* place that touches stdin/stdout;
 * `handleInput` itself doesn't know it's talking to a terminal.
 *
 * `io.input`/`io.output` are injectable specifically so this file is
 * unit-testable without spawning a real subprocess or touching real stdin —
 * the real entrypoint calls it with no `io` argument and gets the real terminal.
 *
 * Used by: `terminal-provider.ts`, wired from the `repl.ts` entrypoint (never by
 * the headless service). `handleInput` there is a closure over `handleTurn`;
 * it also receives an `onChunk` callback (see `startTerminalRepl`'s doc comment)
 * forwarded as the sink's text streaming, so a model response prints as it
 * streams in rather than going silent for the whole answer.
 */
import * as readline from "node:readline";
import { CORE_MESSAGES } from "../i18n/core-messages.ts";

/**
 * Writes to the real process stdout. Appends a newline by default — the
 * prompt is the one caller that passes `{ newline: false }`, since it
 * must stay on the same line as whatever the user types next.
 */
function realOutputWrite(s: string, opts?: { newline?: boolean }): void {
  process.stdout.write(opts?.newline === false ? s : s + "\n");
}

/**
 * Written before the first input and again after every result, so a
 * human at the terminal can tell an answer has finished and the next
 * question can be typed — without this, a multi-line answer and the
 * start of a new question were visually indistinguishable.
 */
export const PROMPT = "> ";

/**
 * Runs the REPL loop: read a line, pass it to `handleInput`, write the
 * result, repeat until the input source is exhausted (EOF).
 *
 * If `handleInput` rejects, the error is written as a line (so a long-
 * running debug session can see what went wrong) and the loop continues
 * with the next line — one bad turn shouldn't kill the whole session.
 *
 * @param handleInput - Turns one line of input into one line of output.
 *   Knows nothing about this being a terminal. Receives `onChunk`, which
 *   it may call zero or more times with pieces of the answer as they
 *   become available (e.g. while streaming a model response) — each
 *   call is written immediately, without waiting for `handleInput` to
 *   resolve. If `onChunk` is never called, the function's returned
 *   string is written instead once `handleInput` resolves, exactly as
 *   before streaming existed — this is what keeps the `/dump` command
 *   and any other non-streaming reply working unchanged. A chunk passed
 *   with `{ aside: true }` (reasoning, a tool label, a confirmation line)
 *   is written the same way but isn't part of the answer, so it's left out
 *   when the returned string is compared with what was streamed.
 * @param io - Test seam. Defaults to real stdin/stdout when omitted.
 * @param opts.promptSuffix - Optional, called fresh right before every
 *   prompt (including the very first one) and written ahead of it — e.g.
 *   a live context-usage indicator (see `src/router/tool-log.ts`'s
 *   `formatContextUsage`), recomputed each time since the value changes
 *   turn to turn.
 * @param opts.correctedNote - Optional, the marker written before an answer
 *   that no longer extends what was streamed, in the person's language;
 *   English when absent.
 */
export async function startTerminalRepl(
  handleInput: (input: string, onChunk: (chunk: string, opts?: { aside?: boolean }) => void) => Promise<string>,
  io?: {
    input?: AsyncIterable<string>;
    output?: { write(s: string, opts?: { newline?: boolean }): void };
  },
  opts?: { promptSuffix?: () => string; correctedNote?: () => string },
): Promise<void> {
  // Real stdin. Passing `output` (needed for readline to own prompt
  // rendering — see below) only when stdin is an actual TTY: passing it
  // against a non-TTY stdin (a Docker container with nothing attached at
  // all — distinct from a *piped* stdin, e.g. `printf ... | docker
  // compose exec -T ...`, which still has real lines to read and works
  // fine either way) crashed the whole process on startup — observed
  // live: `AbortError: Stream reader cancelled via releaseLock()`,
  // thrown from inside readline's own stream handling, not something
  // this file can catch around. Without `output`, the same
  // already-closed stdin just ends the loop with zero lines, same as
  // before today's arrow-key fix — confirmed safe by every previous
  // detached `docker compose up -d` in this project's history.
  const isTTY = !io?.input && process.stdin.isTTY;
  const rl = io?.input
    ? null
    : isTTY
      ? readline.createInterface({ input: process.stdin, output: process.stdout })
      : readline.createInterface({ input: process.stdin });
  // readline in TTY mode intercepts Ctrl+C and emits 'SIGINT' on the interface
  // instead of letting it propagate as a process signal — without this handler
  // Ctrl+C does nothing and the only way to stop Mercury is kill from outside.
  // Not unit-tested: this path requires the real readline in TTY mode, which
  // the io.input test seam bypasses entirely.
  if (isTTY && rl) {
    rl.on("SIGINT", () => process.exit(0));
  }
  const input = io?.input ?? rl!;
  const output = io?.output ?? { write: realOutputWrite };

  const writePrompt = () => {
    const suffix = opts?.promptSuffix?.() ?? "";
    if (isTTY && rl) {
      rl.setPrompt(suffix + PROMPT);
      rl.prompt();
      return;
    }
    if (suffix) {
      output.write(suffix, { newline: false });
    }
    output.write(PROMPT, { newline: false });
  };

  writePrompt();
  for await (const line of input) {
    let streamed = false;
    let streamedText = "";
    const onChunk = (chunk: string, chunkOpts?: { aside?: boolean }) => {
      streamed = true;
      if (!chunkOpts?.aside) streamedText += chunk;
      output.write(chunk, { newline: false });
    };
    try {
      const result = await handleInput(line, onChunk);
      if (!streamed) {
        output.write(result);
      } else if (result.startsWith(streamedText)) {
        // The common case: nothing was streamed beyond what handleInput
        // returns, or turn-runner.ts only appended text after generation
        // finished (e.g. a display the model surfaced via `present`) — the
        // already-streamed prefix is still there, so only the new suffix
        // needs writing.
        output.write(result.slice(streamedText.length));
      } else {
        // The final result no longer extends what was already streamed:
        // a plugin's post-turn guard (turn-runner.ts) rewrote the text
        // after it was streamed. What's already printed
        // can't be un-printed, so show the real final answer in full
        // instead of a slice computed against text that isn't there
        // anymore.
        const note = opts?.correctedNote?.() ?? CORE_MESSAGES["core.terminal.corrected"];
        output.write(`\n\n${note}\n\n${result}`);
      }
    } catch (err) {
      if (streamed) {
        output.write("");
      }
      output.write(`error: ${String(err instanceof Error ? err.message : err)}`);
    }
    writePrompt();
  }
}
