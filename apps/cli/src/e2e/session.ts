/**
 * The REPL session `mfw e2e` drives: the app's REPL as a child process (in
 * the app's container, through `docker compose run`), fed one turn at a time.
 * A turn writes its line and then `/dump <file>` together: the REPL handles
 * one line after the other, so the dump runs once the turn is over, and its
 * "wrote … to <file>" line is the turn's end, unlike the prompt, which an
 * answer's own text could look like. The dump is read from the host side of
 * the folder the REPL writes it into.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplReply, Session } from "./runner.ts";

export type ReplSessionOptions = {
  /** The command that starts the REPL. */
  argv: string[];
  cwd: string;
  /** Where the dumps are, on this side, and as the REPL sees the same folder. */
  hostDir: string;
  replDir: string;
  /** Prefix of this session's dump files, unique among sessions sharing the folder. */
  name: string;
  /** How long one turn may take. */
  timeoutMs: number;
  /** Starts the REPL; a test hands in a stand-in process. */
  spawn?: (argv: string[], cwd: string) => ReplProcess;
};

/** The parts of a spawned process the session uses. */
export type ReplProcess = {
  stdin: { write: (text: string) => unknown; flush: () => unknown; end: () => unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

/** How long, once the REPL is gone, its stderr may take to be read to its end. */
const STDERR_DRAIN_MS = 1000;

function spawnRepl(argv: string[], cwd: string): ReplProcess {
  return Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

/** Starts the REPL and returns the session over it once the REPL is ready
 * (its first prompt is out), so a turn's time is only the turn's; throws
 * when the REPL exits or doesn't get there in time. */
export async function openReplSession(opts: ReplSessionOptions): Promise<Session<ReplReply>> {
  const proc = (opts.spawn ?? spawnRepl)(opts.argv, opts.cwd);
  let stdout = "";
  let stderr = "";
  let exited: number | undefined;
  /** Wakes whoever waits for more output or for the exit. */
  let notify = () => {};
  const pump = async (stream: ReadableStream<Uint8Array>, add: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      add(decoder.decode(chunk, { stream: true }));
      notify();
    }
  };
  void pump(proc.stdout, (t) => (stdout += t));
  const stderrRead = pump(proc.stderr, (t) => (stderr += t)).catch(() => {});
  // The exit counts once stderr is read to its end, or the reason it gives is
  // lost; a grandchild still holding the pipe open bounds the wait.
  void proc.exited.then(async (code) => {
    await Promise.race([stderrRead, new Promise((r) => setTimeout(r, STDERR_DRAIN_MS))]);
    exited = code;
    notify();
  });

  /** Waits until `done` holds on the output so far; throws when the REPL exits or time runs out. */
  const waitFor = async <T>(done: () => T | undefined): Promise<T> => {
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const result = done();
      if (result !== undefined) return result;
      if (exited !== undefined) throw new Error(`the REPL exited with code ${exited}: ${stderr.trim().split("\n").slice(-3).join(" ")}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no reply within ${opts.timeoutMs / 1000} s`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };

  // What the REPL prints while starting isn't part of any turn. One that
  // doesn't get there is stopped: a docker compose run container otherwise
  // keeps running.
  try {
    await waitFor(() => (/> $/.test(stdout) ? true : undefined));
  } catch (err) {
    proc.kill();
    throw err;
  }

  let turns = 0;
  return {
    turn: async (line) => {
      turns++;
      const file = `${opts.name}-turn-${turns}.json`;
      const marker = `to ${opts.replDir}/${file}`;
      const from = stdout.length;
      proc.stdin.write(`${line}\n/dump ${opts.replDir}/${file}\n`);
      proc.stdin.flush();
      return waitFor(() => {
        const at = stdout.indexOf(marker, from);
        if (at === -1) return undefined;
        // What the turn printed: everything before the dump's own line.
        const output = stdout.slice(from, stdout.lastIndexOf("wrote ", at));
        return { dump: JSON.parse(readFileSync(join(opts.hostDir, file), "utf-8")) as unknown, output };
      });
    },
    close: async () => {
      if (exited !== undefined) return;
      proc.stdin.end();
      const done = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
      if (done === "timeout") proc.kill();
    },
  };
}
