/**
 * The REPL session `mfw e2e` drives, against a stand-in REPL (a script that
 * reads lines like the real one, answers, and writes `/dump` files): each
 * turn is the line plus `/dump`, and ends when the REPL says it wrote the dump.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReplSession } from "./session.ts";

let dir: string;
let fakeRepl: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mfw-e2e-session-"));
  fakeRepl = join(dir, "fake-repl.ts");
  // Answers "answer to <line>" (slowly for "slow"), dies on "die", and writes
  // a one-step dump of the last line on `/dump <path>`, like the real REPL.
  writeFileSync(
    fakeRepl,
    `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
let last = "";
process.stdout.write("> ");
for await (const line of createInterface({ input: process.stdin })) {
  const dump = line.match(/^\\/dump (\\S+)$/);
  if (dump) {
    writeFileSync(dump[1], JSON.stringify([{ content: [{ type: "text", text: "answer to " + last }] }]));
    process.stdout.write("wrote 1 tool step(s) from the last turn to " + dump[1] + "\\n[~1k/~2k tokens] > ");
    continue;
  }
  if (line === "die") { console.error("model unreachable"); process.exit(3); }
  if (line === "slow") await new Promise((r) => setTimeout(r, 2000));
  last = line;
  process.stdout.write("thinking…\\nanswer to " + line + "\\n[~1k/~2k tokens] > ");
}
`,
  );
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const open = async (timeoutMs = 10_000) =>
  await openReplSession({ argv: ["bun", fakeRepl], cwd: dir, hostDir: dir, replDir: dir, name: "s1", timeoutMs });

describe("openReplSession", () => {
  test("a turn sends the line and /dump, and hands back the dump and what was printed before it", async () => {
    const session = await open();
    const first = await session.turn("hello");
    expect(first.dump).toEqual([{ content: [{ type: "text", text: "answer to hello" }] }]);
    expect(first.output).toBe("thinking…\nanswer to hello\n[~1k/~2k tokens] > ");
    const second = await session.turn("again");
    expect(second.dump).toEqual([{ content: [{ type: "text", text: "answer to again" }] }]);
    await session.close();
  });

  test("each turn's dump has its own file", async () => {
    const session = await open();
    await session.turn("a");
    await session.turn("b");
    await session.close();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).sort()).toEqual(["s1-turn-1.json", "s1-turn-2.json"]);
  });

  test("a REPL that exits mid-turn: an error with its exit code and stderr", async () => {
    const session = await open();
    await expect(session.turn("die")).rejects.toThrow("the REPL exited with code 3: model unreachable");
  });

  // #131: the first turn waited for the REPL to start, so its seconds
  // counted the container's startup too. Opening resolves only once the
  // first prompt is out: checked on a stand-in whose prompt the test releases,
  // so no wall-clock time is involved.
  test("opening waits for the REPL's first prompt: a turn's time is its own", async () => {
    const encoder = new TextEncoder();
    let printPrompt = () => {};
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode("starting the container…\n"));
        printPrompt = () => controller.enqueue(encoder.encode("> "));
      },
    });
    const spawn = () => ({
      stdin: { write: () => {}, flush: () => {}, end: () => {} },
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: new Promise<number>(() => {}),
      kill: () => {},
    });
    let opened = false;
    const opening = openReplSession({ argv: ["repl"], cwd: dir, hostDir: dir, replDir: dir, name: "s1", timeoutMs: 10_000, spawn }).then(
      (session) => {
        opened = true;
        return session;
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toBe(false);
    printPrompt();
    await opening;
    expect(opened).toBe(true);
  });

  test("a REPL that never starts: opening fails with its exit code and stderr", async () => {
    await expect(
      openReplSession({ argv: ["bun", "-e", "console.error('no model'); process.exit(4)"], cwd: dir, hostDir: dir, replDir: dir, name: "s1", timeoutMs: 10_000 }),
    ).rejects.toThrow("the REPL exited with code 4: no model");
  });

  // #220: the exit was taken as known as soon as the process ended, before
  // stderr had been read to its end, so the error could come without the
  // reason ("exited with code 4: "), now and then in CI. A process whose exit
  // is known before its stderr arrives makes that order certain.
  test("a REPL whose stderr arrives after its exit: the error still carries it", async () => {
    const encoder = new TextEncoder();
    const lateStderr = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        await new Promise((r) => setTimeout(r, 50));
        controller.enqueue(encoder.encode("starting\nno model\n"));
        controller.close();
      },
    });
    const spawn = () => ({
      stdin: { write: () => {}, flush: () => {}, end: () => {} },
      stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      stderr: lateStderr,
      exited: Promise.resolve(4),
      kill: () => {},
    });
    await expect(
      openReplSession({ argv: ["repl"], cwd: dir, hostDir: dir, replDir: dir, name: "s1", timeoutMs: 10_000, spawn }),
    ).rejects.toThrow("the REPL exited with code 4: starting no model");
  });

  // A grandchild can keep the pipe open after the REPL is gone: the reason
  // read so far is reported rather than waiting on it.
  test("a REPL whose stderr never closes after its exit: the error comes anyway, with what was read", async () => {
    const encoder = new TextEncoder();
    const openStderr = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(encoder.encode("no model\n")) });
    const spawn = () => ({
      stdin: { write: () => {}, flush: () => {}, end: () => {} },
      stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      stderr: openStderr,
      exited: new Promise<number>((r) => setTimeout(() => r(4), 20)),
      kill: () => {},
    });
    const started = Date.now();
    await expect(
      openReplSession({ argv: ["repl"], cwd: dir, hostDir: dir, replDir: dir, name: "s1", timeoutMs: 10_000, spawn }),
    ).rejects.toThrow("the REPL exited with code 4: no model");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // #131 review: a REPL that never got to its prompt was left running (a
  // docker compose run container, in real use).
  test("a REPL that doesn't start in time: opening fails, and the REPL is stopped", async () => {
    const pidFile = join(dir, "pid");
    const hang = join(dir, "hang.ts");
    writeFileSync(hang, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
    await expect(openReplSession({ argv: ["bun", hang], cwd: dir, hostDir: dir, replDir: dir, name: "s1", timeoutMs: 1000 })).rejects.toThrow(
      "no reply within 1 s",
    );
    const pid = Number(require("node:fs").readFileSync(pidFile, "utf-8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a turn longer than the timeout: an error saying so", async () => {
    const session = await open(500);
    await expect(session.turn("slow")).rejects.toThrow("no reply within 0.5 s");
    await session.close();
  });
});
