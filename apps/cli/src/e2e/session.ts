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
};

/** Starts the REPL and returns the session over it once the REPL is ready
 * (its first prompt is out), so a turn's time is only the turn's; throws
 * when the REPL exits or doesn't get there in time. */
export async function openReplSession(opts: ReplSessionOptions): Promise<Session<ReplReply>> {
  const proc = Bun.spawn(opts.argv, { cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
  void pump(proc.stderr, (t) => (stderr += t));
  void proc.exited.then((code) => {
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
