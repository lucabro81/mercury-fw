import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Tool } from "ai";
import { TurnOutputError, type FinalizeInfo, type InboundTurn, type Principal, type TraceEvent } from "@mercury-fw/channel-types";
import type { TurnRecordInfo } from "../plugins/plugin-hooks.ts";
import { createTurnRunner, type PostTurnGuard, type TurnRunnerDeps } from "./turn-runner.ts";
import type { TurnSink } from "./provider.ts";
import { keptHistory } from "../session/__fixtures__/kept-history.ts";
import type { runTurn } from "../session/agent-turn.ts";
import type { ResolvedOutput } from "../session/turn-output.ts";

type RunDeps = Parameters<typeof runTurn>[2];

const alice: Principal = { id: "alice", provider: "google-chat" };
const turn = (overrides: Partial<InboundTurn> = {}): InboundTurn => ({ channel: "http", multiUser: false, text: "books by dante", sessionKey: "s1", principal: alice, logPrefix: "", ...overrides });

/** A sink that keeps what it was finalized with. */
function sink(overrides: Partial<TurnSink> = {}) {
  const finalized: Array<{ text: string; info?: FinalizeInfo }> = [];
  return {
    finalized,
    sink: {
      onToolStart: () => {},
      finalize: async (text: string, info?: FinalizeInfo) => void finalized.push(info === undefined ? { text } : { text, info }),
      dispose: () => {},
      ...overrides,
    } as TurnSink,
  };
}

const value = { ok: true, query: "author ~ 'dante'", display: { type: "search-link", items: ["https://catalog/?q=dante"] } };
const json = JSON.stringify(value, null, 2);
const plainTool = { description: "d", inputSchema: z.object({}), execute: async () => ({}) } as unknown as Tool;

/** A runner over `output`, its `runTurn` played by `run`, recording what it was handed. */
function runner(output: ResolvedOutput | undefined, run: (deps: RunDeps) => Promise<string>, extra: Partial<TurnRunnerDeps> = {}) {
  const runDeps: RunDeps[] = [];
  const buildArgs: unknown[][] = [];
  const events: TraceEvent[] = [];
  const records: TurnRecordInfo[] = [];
  const guardRuns: string[] = [];
  const guard: PostTurnGuard = { statusLabel: () => "g", statusId: "g", shouldRun: () => true, run: async (text) => (guardRuns.push(text), { text: `${text}\n\nSources`, outcome: "success" }) };
  const handle = createTurnRunner({
    model: {} as never,
    systemPrompts: { singleUser: "single", multiUser: "multi" },
    buildTools: (...args: unknown[]) => (buildArgs.push(args), { resolve_reference: plainTool }),
    getOrCreateHistory: () => keptHistory(),
    trackSession: () => {},
    logStep: () => {},
    runTurnFn: async (_h, _i, deps) => (runDeps.push(deps), run(deps)),
    postTurnGuards: [guard],
    takeSurfacedDisplays: () => ["MER-1\nhttps://x"],
    tracer: { emit: (e) => void events.push(e as TraceEvent), flush: async () => {} },
    turnRecord: (_who, record) => void records.push(record),
    ...(output === undefined ? {} : { output }),
    ...extra,
  });
  return { handle, runDeps, buildArgs, events, records, guardRuns };
}

const toolOutput: ResolvedOutput = { mode: "tool", plugin: "comperio-query", tool: "comperio_query_build", retries: 2 };
const schemaOutput: ResolvedOutput = { mode: "schema", schema: z.object({ query: z.string() }), retries: 1 };

describe("the turn runner with an output (#403)", () => {
  test("a tool output: the probe goes to buildTools, the output to finalize, no guards, no displays", async () => {
    const r = runner(toolOutput, async (deps) => {
      deps.onTextChunk?.("Here is your query");
      deps.onOutput?.({ mode: "tool", value }, 2);
      return json;
    });
    const streamed: string[] = [];
    const s = sink({ onTextChunk: (chunk) => void streamed.push(chunk) });
    await r.handle(turn(), s.sink);

    const outputTool = r.buildArgs[0]![6] as { plugin: string; tool: string; probe: { offered: boolean } };
    expect(outputTool.plugin).toBe("comperio-query");
    expect(outputTool.tool).toBe("comperio_query_build");
    const deps = r.runDeps[0]!;
    expect(deps.output).toMatchObject({ mode: "tool", tool: "comperio_query_build", retries: 2 });
    expect((deps.output as { probe: unknown }).probe).toBe(outputTool.probe);
    // The answer isn't streamed: the model's text isn't the output.
    expect(streamed).toEqual([]);
    expect(s.finalized).toEqual([{ text: json, info: { output: { mode: "tool", value } } }]);
    expect(r.guardRuns).toEqual([]);
    expect(r.events.find((e) => e.kind === "turn.output")).toMatchObject({ kind: "turn.output", mode: "tool", outcome: "done", attempts: 2 });
    expect(r.records[0]).toMatchObject({ kind: "turn", outcome: "done", answer: { content: json, output: { mode: "tool", value } } });
    expect((r.records[0] as { answer?: { displays?: unknown } }).answer?.displays).toBeUndefined();
  });

  test("a schema output with only the core's tools gives the model none: one constrained call", async () => {
    const r = runner(schemaOutput, async (deps) => {
      deps.onOutput?.({ mode: "schema", value: { query: "x" } }, 1);
      return "{}";
    });
    await r.handle(turn(), sink().sink);
    expect(r.runDeps[0]!.tools).toEqual({});
    expect(r.runDeps[0]!.output).toMatchObject({ mode: "schema", retries: 1 });
    expect(r.buildArgs[0]![6]).toBeUndefined();
  });

  test("a schema output keeps the tools when a plugin offers some", async () => {
    const r = runner(schemaOutput, async () => "{}", { buildTools: () => ({ resolve_reference: plainTool, lookup: plainTool }) });
    await r.handle(turn(), sink().sink);
    expect(Object.keys(r.runDeps[0]!.tools)).toEqual(["resolve_reference", "lookup"]);
  });

  test("text, the default, runs as today: guards and displays", async () => {
    const r = runner(undefined, async () => "answer");
    const s = sink();
    await r.handle(turn(), s.sink);
    expect(r.runDeps[0]!.output).toBeUndefined();
    expect(r.guardRuns).toEqual(["answer"]);
    expect(s.finalized[0]!.text).toContain("Sources");
    expect(s.finalized[0]!.info).toBeUndefined();
    expect(r.events.some((e) => e.kind === "turn.output")).toBe(false);
  });

  test("an opening turn with an output says nothing and leaves nothing", async () => {
    const r = runner(toolOutput, async () => json);
    const s = sink();
    await r.handle(turn({ opening: true, text: "" }), s.sink);
    expect(r.runDeps).toHaveLength(0);
    expect(s.finalized).toEqual([{ text: "" }]);
  });

  test("a typed error: the turn fails with it, and turn.output says why", async () => {
    const r = runner(toolOutput, async () => {
      throw new TurnOutputError("output-missing", { attempts: 3, lastError: 'the turn ended without calling the tool "comperio_query_build"' });
    });
    const s = sink();
    const err = await r.handle(turn(), s.sink).catch((e) => e);
    expect(err).toMatchObject({ kind: "turn-output", code: "output-missing" });
    expect(s.finalized).toEqual([]);
    expect(r.events.find((e) => e.kind === "turn.output")).toMatchObject({ mode: "tool", outcome: "output-missing", attempts: 3 });
    expect(r.events.find((e) => e.kind === "turn.end")).toMatchObject({ outcome: "failed" });
  });

  test("a staged action with an output ends as today: the pending note, no output", async () => {
    let note = "";
    const r = runner(toolOutput, async (deps) => {
      note = deps.pendingNote!;
      deps.onPendingNote?.();
      return deps.pendingNote!;
    });
    const s = sink();
    await r.handle(turn(), s.sink);
    expect(s.finalized).toEqual([{ text: note, info: { pendingNote: note } }]);
    expect(r.events.some((e) => e.kind === "turn.output")).toBe(false);
  });

  test("the watchdog doesn't take a silent constrained call for a stall", async () => {
    let fired = false;
    const r = runner(
      schemaOutput,
      async (deps) => {
        deps.onSilentCall?.(true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        deps.onSilentCall?.(false);
        deps.onOutput?.({ mode: "schema", value: {} }, 1);
        return "{}";
      },
      {
        stallTimeoutMs: 10,
        stallTimer: (fn, ms) => {
          const id = setTimeout(() => {
            fired = true;
            fn();
          }, ms);
          return () => clearTimeout(id);
        },
      },
    );
    await r.handle(turn(), sink({ onReasoningChunk: () => {} }).sink);
    expect(fired).toBe(false);
  });
});
