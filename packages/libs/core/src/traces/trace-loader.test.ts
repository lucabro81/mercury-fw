import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACE_SINK_API_VERSION, type TraceEvent, type TraceSinkPlugin } from "@mercury-fw/channel-types";
import { loadTracer } from "./trace-loader.ts";
import { noopTracer, pseudonymOf } from "./tracer.ts";
import { traceSecretPath } from "./trace-secret.ts";

const NOW = Date.UTC(2026, 10, 11, 9, 30, 0);
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-trace-loader-"));
  dirs.push(dir);
  return dir;
}

/** A sink plugin whose events land in `events`, and whose build context is kept in `built`. */
function collectingPlugin(apiVersion = TRACE_SINK_API_VERSION) {
  const events: TraceEvent[] = [];
  const built: Array<Parameters<TraceSinkPlugin["build"]>[0]> = [];
  const plugin: TraceSinkPlugin = {
    apiVersion,
    name: "collect",
    build: (ctx) => {
      built.push(ctx);
      return { write: (e) => events.push(e), flush: async () => {} };
    },
  };
  return { plugin, events, built };
}

describe("loadTracer", () => {
  test("no traces declared: the no-op tracer, silently, and nothing written on the volume", async () => {
    const vault = await tempVault();
    const logs: string[] = [];
    const tracer = await loadTracer(undefined, { env: {}, log: (m) => logs.push(m), dataPath: vault, now: () => NOW });
    expect(tracer).toBe(noopTracer);
    expect(logs).toEqual([]);
    await expect(stat(traceSecretPath(vault))).rejects.toThrow();
  });

  test("builds the sink with the env, the logger and its own folder, traces/ in the data folder, which exists", async () => {
    const vault = await tempVault();
    const { plugin, built } = collectingPlugin();
    const env = { X: "1" };
    const log = () => {};
    await loadTracer({ sink: plugin }, { env, log, dataPath: vault, now: () => NOW });
    expect(built).toHaveLength(1);
    expect(built[0]!.env).toBe(env);
    expect(built[0]!.log).toBe(log);
    expect(built[0]!.dir).toBe(join(vault, "traces"));
    expect((await stat(built[0]!.dir)).isDirectory()).toBe(true);
  });

  test("the level defaults to meta: args don't reach the sink", async () => {
    const vault = await tempVault();
    const { plugin, events } = collectingPlugin();
    const tracer = await loadTracer({ sink: plugin }, { env: {}, log: () => {}, dataPath: vault, now: () => NOW });
    tracer.emit({ kind: "tool.call", args: { input: "x" } });
    expect(events).toEqual([{ at: "2026-11-11T09:30:00.000Z", kind: "tool.call" }]);
  });

  test("the declared level is applied, and pseudonyms use the secret stored on the volume", async () => {
    const vault = await tempVault();
    const { plugin, events } = collectingPlugin();
    const tracer = await loadTracer({ sink: plugin, level: "args" }, { env: {}, log: () => {}, dataPath: vault, now: () => NOW });
    tracer.emit({ kind: "tool.call", person: "static:bob", args: { input: "x" } });
    const secret = (await readFile(traceSecretPath(vault), "utf8")).trim();
    expect(events).toEqual([{ at: "2026-11-11T09:30:00.000Z", kind: "tool.call", person: pseudonymOf(secret, "static:bob"), args: { input: "x" } }]);
  });

  test("a level that isn't meta or args is a mistake in the config: startup stops, naming it", async () => {
    const vault = await tempVault();
    const { plugin } = collectingPlugin();
    await expect(
      loadTracer({ sink: plugin, level: "full" as "meta" }, { env: {}, log: () => {}, dataPath: vault, now: () => NOW }),
    ).rejects.toThrow('traces.level must be "meta" or "args"');
  });

  test("a sink written for another contract is refused without being built: no traces, and the instance starts", async () => {
    const vault = await tempVault();
    const logs: string[] = [];
    const { plugin, built } = collectingPlugin(TRACE_SINK_API_VERSION + 1);
    const tracer = await loadTracer({ sink: plugin }, { env: {}, log: (m) => logs.push(m), dataPath: vault, now: () => NOW });
    expect(tracer).toBe(noopTracer);
    expect(built).toHaveLength(0);
    expect(logs).toEqual([
      `trace sink "collect" not activated: apiVersion ${TRACE_SINK_API_VERSION + 1} incompatible with this core (supports ${TRACE_SINK_API_VERSION})`,
    ]);
  });

  test("a sink whose build throws is left out, logged: no traces, and the instance starts", async () => {
    const vault = await tempVault();
    const logs: string[] = [];
    const plugin: TraceSinkPlugin = {
      apiVersion: TRACE_SINK_API_VERSION,
      name: "broken",
      build: mock(() => {
        throw new Error("read-only volume");
      }),
    };
    const tracer = await loadTracer({ sink: plugin }, { env: {}, log: (m) => logs.push(m), dataPath: vault, now: () => NOW });
    expect(tracer).toBe(noopTracer);
    expect(logs).toEqual(['trace sink "broken" failed to load: read-only volume']);
  });

  test("an unusable trace secret leaves traces off, logged, without building the sink", async () => {
    const vault = await tempVault();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(vault, { recursive: true });
    await writeFile(traceSecretPath(vault), "garbage\n");
    const logs: string[] = [];
    const { plugin, built } = collectingPlugin();
    const tracer = await loadTracer({ sink: plugin }, { env: {}, log: (m) => logs.push(m), dataPath: vault, now: () => NOW });
    expect(tracer).toBe(noopTracer);
    expect(built).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("traces off");
  });
});
