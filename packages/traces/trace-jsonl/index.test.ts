import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACE_SINK_API_VERSION, type TraceEvent, type TraceSink } from "@mercury-fw/channel-types";
import { jsonlTraces } from "./index.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-trace-jsonl-"));
  dirs.push(dir);
  return dir;
}

function event(at: string, kind = "turn.start", extra: Record<string, unknown> = {}): TraceEvent {
  return { at, kind, ...extra };
}

function build(dir: string, keepDays?: number, logs: string[] = []): TraceSink {
  const plugin = keepDays === undefined ? jsonlTraces() : jsonlTraces({ keepDays });
  return plugin.build({ env: {}, log: (m) => logs.push(m), dir });
}

async function lines(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function dayFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
}

describe("jsonlTraces", () => {
  test("is a trace sink for this contract, named jsonl", () => {
    const plugin = jsonlTraces();
    expect(plugin.apiVersion).toBe(TRACE_SINK_API_VERSION);
    expect(plugin.name).toBe("jsonl");
  });

  test("writes each event as one JSON line, in the order written, into the file of its UTC day", async () => {
    const dir = await tempDir();
    const sink = build(dir);
    const written = Array.from({ length: 50 }, (_, i) => event("2026-11-11T09:30:00.000Z", "tool.call", { n: i }));
    for (const e of written) sink.write(e);
    await sink.flush();
    expect(await dayFiles(dir)).toEqual(["2026-11-11.jsonl"]);
    expect(await lines(join(dir, "2026-11-11.jsonl"))).toEqual(written);
  });

  test("an event just before midnight UTC and one just after go to two files", async () => {
    const dir = await tempDir();
    const sink = build(dir);
    sink.write(event("2026-11-11T23:59:59.999Z"));
    sink.write(event("2026-11-12T00:00:00.000Z"));
    await sink.flush();
    expect(await dayFiles(dir)).toEqual(["2026-11-11.jsonl", "2026-11-12.jsonl"]);
  });

  test("appends to a day's file across restarts instead of replacing it", async () => {
    const dir = await tempDir();
    const first = build(dir);
    first.write(event("2026-11-11T09:00:00.000Z", "a"));
    await first.flush();
    const second = build(dir);
    second.write(event("2026-11-11T10:00:00.000Z", "b"));
    await second.flush();
    expect((await lines(join(dir, "2026-11-11.jsonl"))).map((e) => (e as TraceEvent).kind)).toEqual(["a", "b"]);
  });

  test("keeps the last 7 days with activity by default: older day files go when the sink starts", async () => {
    const dir = await tempDir();
    const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-20"];
    for (const d of days) await writeFile(join(dir, `${d}.jsonl`), "{}\n");
    await build(dir).flush();
    expect(await dayFiles(dir)).toEqual(days.slice(2).map((d) => `${d}.jsonl`));
  });

  test("days without activity don't count: two busy days followed by a quiet month are all still there", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "2026-09-01.jsonl"), "{}\n");
    await writeFile(join(dir, "2026-09-02.jsonl"), "{}\n");
    const sink = build(dir);
    sink.write(event("2026-10-15T08:00:00.000Z"));
    await sink.flush();
    expect(await dayFiles(dir)).toEqual(["2026-09-01.jsonl", "2026-09-02.jsonl", "2026-10-15.jsonl"]);
  });

  test("a new day's first event drops the oldest day once there are more than keepDays", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "2026-11-01.jsonl"), "{}\n");
    await writeFile(join(dir, "2026-11-02.jsonl"), "{}\n");
    const sink = build(dir, 2);
    await sink.flush();
    expect(await dayFiles(dir)).toEqual(["2026-11-01.jsonl", "2026-11-02.jsonl"]);
    sink.write(event("2026-11-03T08:00:00.000Z"));
    await sink.flush();
    expect(await dayFiles(dir)).toEqual(["2026-11-02.jsonl", "2026-11-03.jsonl"]);
  });

  test("leaves every other file in its folder alone", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "notes.txt"), "mine");
    await writeFile(join(dir, "2026-01-01.jsonl.bak"), "mine");
    for (const d of ["2026-11-01", "2026-11-02", "2026-11-03"]) await writeFile(join(dir, `${d}.jsonl`), "{}\n");
    await build(dir, 1).flush();
    expect((await readdir(dir)).sort()).toEqual(["2026-01-01.jsonl.bak", "2026-11-03.jsonl", "notes.txt"]);
  });

  test("a write that fails never throws to the caller, is logged once, and flush still resolves", async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    const sink = build(dir, 7, logs);
    await sink.flush();
    await chmod(dir, 0o500);
    expect(() => {
      sink.write(event("2026-11-11T09:00:00.000Z"));
      sink.write(event("2026-11-11T09:00:01.000Z"));
    }).not.toThrow();
    await sink.flush();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[traces]");
  });

  test("keepDays must be a whole number from 1 up: anything else is a mistake in the config", () => {
    for (const keepDays of [0, -1, 1.5, Number.NaN]) {
      expect(() => jsonlTraces({ keepDays })).toThrow("jsonlTraces: keepDays must be a whole number from 1 up");
    }
  });
});
