import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ModelMessage, StopCondition, Tool } from "ai";
import { isTurnOutputError, type TurnOutput } from "@mercury-fw/channel-types";
import { runTurn } from "./agent-turn.ts";
import { createOutputProbe, type Validate } from "./turn-output.ts";
import { keptHistory } from "./__fixtures__/kept-history.ts";
import type { StepInfo } from "./step-info.ts";
import { CORE_MESSAGES } from "../i18n/core-messages.ts";

const SYSTEM = "you are a test assistant";

/** What the build tool returns: the query, and the link as the person's display. */
const built = (query: string) => ({ ok: true, query, display: { type: "search-link", items: [`https://catalog/?q=${query}`] } });

/** A tool calling `run` with its input, like a plugin's tool. */
const toolOfFn = (run: (input: { query: string }) => unknown): Tool => ({ description: "d", inputSchema: z.object({ query: z.string() }), execute: async (input: { query: string }) => run(input) }) as unknown as Tool;

type Call = { tool: string; input: unknown };
/** One model call's script: rounds of tool calls, each a step, then the text it ends with. */
type Round = { steps: Call[][]; text?: string };

/**
 * A fake `generateText` that plays `rounds`, one per call: each step runs its
 * tools for real (so the probe sees them) and the call stops after a step
 * that meets one of `stopWhen`'s extra conditions, as the AI SDK does.
 */
function scripted(rounds: Round[]) {
  const seen: ModelMessage[][] = [];
  const results: unknown[] = [];
  let call = 0;
  const fn = async (params: {
    messages: ModelMessage[];
    tools: Record<string, Tool>;
    onStepEnd?: (s: StepInfo) => void;
    stopWhen?: StopCondition<any>[];
  }) => {
    seen.push(params.messages);
    const round = rounds[call++] ?? { steps: [], text: "" };
    const done: StepInfo[] = [];
    for (const [i, calls] of round.steps.entries()) {
      const step: StepInfo = { toolCalls: [], toolResults: [], content: [] };
      for (const [j, c] of calls.entries()) {
        const id = `c${call}-${i}-${j}`;
        const output = await (params.tools[c.tool]!.execute as (x: unknown, o: unknown) => Promise<unknown>)(c.input, {});
        step.toolCalls.push({ toolCallId: id, toolName: c.tool, input: c.input });
        results.push(output);
        step.toolResults.push({ toolCallId: id, toolName: c.tool, output });
      }
      done.push(step);
      params.onStepEnd?.(step);
      const stops = await Promise.all((params.stopWhen ?? []).map((s) => s({ steps: done as never })));
      if (stops.some(Boolean)) return { text: "" };
    }
    return { text: round.text ?? "" };
  };
  return { fn, seen, results, calls: () => call };
}

/** The tool output a turn runs with, over a probe that wraps `tools.build`. */
function toolTurn(build: Tool, opts: { validate?: Validate; retries?: number } = {}) {
  const probe = createOutputProbe(opts.validate);
  const outputs: Array<{ output: TurnOutput; attempts: number }> = [];
  return {
    tools: { build: probe.wrapTool(build) },
    output: { mode: "tool" as const, tool: "build", probe, retries: opts.retries ?? 2 },
    onOutput: (output: TurnOutput, attempts: number) => outputs.push({ output, attempts }),
    outputs,
  };
}

/** The tool results the model was shown in `messages`, in order. */
const toolResultsIn = (messages: ModelMessage[]) =>
  messages.flatMap((m) => (m.role === "tool" ? m.content.flatMap((p) => (p.type === "tool-result" ? [p.output] : [])) : []));

/** The last user message's text in `messages`. */
const lastUser = (messages: ModelMessage[]) => {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : "";
};

describe("runTurn with output: { tool }", () => {
  it("ends the turn with the tool's whole result, display included, when it's accepted at once", async () => {
    const history = keptHistory();
    const turn = toolTurn(toolOfFn(({ query }) => built(query)));
    const model = scripted([{ steps: [[{ tool: "build", input: { query: "dante" } }]], text: "never written" }]);

    const text = await runTurn(history, "books by dante", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput });

    expect(turn.outputs).toEqual([{ output: { mode: "tool", value: built("dante") }, attempts: 1 }]);
    expect(text).toBe(JSON.stringify(built("dante"), null, 2));
    expect(model.calls()).toBe(1);
    const last = history.getMessages().at(-1)!;
    expect(last).toMatchObject({ role: "assistant", content: JSON.stringify(built("dante"), null, 2) });
    expect(last.calls?.map((c) => c.toolName)).toEqual(["build"]);
  });

  it("tells the model the validator's error and ends on the value it accepts", async () => {
    const history = keptHistory();
    const validate: Validate = (v) => ((v as { query: string }).query === "dante" ? { ok: true } : { ok: false, error: 'there\'s no field "titel"' });
    const turn = toolTurn(toolOfFn(({ query }) => built(query)), { validate });
    const model = scripted([{ steps: [[{ tool: "build", input: { query: "titel" } }], [{ tool: "build", input: { query: "dante" } }]] }]);

    await runTurn(history, "books by dante", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput });

    expect(turn.outputs).toEqual([{ output: { mode: "tool", value: built("dante") }, attempts: 2 }]);
    expect(model.results).toEqual([{ ok: false, error: 'there\'s no field "titel"' }, built("dante")]);
  });

  it("a refused value reaches the model as the validator's error, not as the tool's result", async () => {
    const results: unknown[] = [];
    const turn = toolTurn(toolOfFn(({ query }) => built(query)), { validate: () => ({ ok: false, error: "wrong field" }), retries: 0 });
    const out = await (turn.tools.build.execute as (x: unknown, o: unknown) => Promise<unknown>)({ query: "x" }, {});
    results.push(out);
    expect(results).toEqual([{ ok: false, error: "wrong field" }]);
  });

  it("the tool's own failure reaches the model as it is, and counts as an attempt", async () => {
    const history = keptHistory();
    const failed = { ok: false, errors: [{ message: "unbalanced parenthesis" }] };
    let n = 0;
    const turn = toolTurn(toolOfFn(({ query }) => (n++ === 0 ? failed : built(query))));
    const model = scripted([{ steps: [[{ tool: "build", input: { query: "(dante" } }], [{ tool: "build", input: { query: "dante" } }]] }]);

    await runTurn(history, "books by dante", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput });

    expect(model.results[0]).toEqual(failed);
    expect(turn.outputs[0]!.attempts).toBe(2);
    expect(turn.outputs[0]!.output.value).toEqual(built("dante"));
  });

  it("a model that ends with text is told to call the tool, and the retry isn't kept in the history", async () => {
    const history = keptHistory();
    const turn = toolTurn(toolOfFn(({ query }) => built(query)));
    const model = scripted([{ steps: [], text: "Here is your query: dante" }, { steps: [[{ tool: "build", input: { query: "dante" } }]] }]);

    await runTurn(history, "books by dante", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput });

    expect(model.calls()).toBe(2);
    const second = model.seen[1]!;
    expect(second.some((m) => m.role === "assistant" && m.content === "Here is your query: dante")).toBe(true);
    expect(lastUser(second)).toBe('End the turn by calling the tool "build": its result is the answer. Write no text instead.');
    expect(turn.outputs[0]!.attempts).toBe(2);
    expect(history.getMessages().map((m) => m.content)).toEqual(["books by dante", JSON.stringify(built("dante"), null, 2)]);
  });

  it("a retry shows the model the calls it made before, with their whole results", async () => {
    const history = keptHistory();
    const turn = toolTurn(toolOfFn(({ query }) => built(query)), { validate: (v) => ((v as { query: string }).query === "ok" ? { ok: true } : { ok: false, error: "no" }) });
    const model = scripted([{ steps: [[{ tool: "build", input: { query: "bad" } }]], text: "done" }, { steps: [[{ tool: "build", input: { query: "ok" } }]] }]);

    await runTurn(history, "q", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput });

    expect(toolResultsIn(model.seen[1]!)).toEqual([{ type: "json", value: { ok: false, error: "no" } }]);
  });

  it("fails with output-missing once the retries are spent on text", async () => {
    const history = keptHistory();
    const turn = toolTurn(toolOfFn(({ query }) => built(query)), { retries: 2 });
    const model = scripted([{ steps: [], text: "a" }, { steps: [], text: "b" }, { steps: [], text: "c" }, { steps: [], text: "d" }]);

    const err = await runTurn(history, "q", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput }).catch((e) => e);

    expect(isTurnOutputError(err)).toBe(true);
    expect(err).toMatchObject({ code: "output-missing", attempts: 3, lastError: 'the turn ended without calling the tool "build"' });
    expect(model.calls()).toBe(3);
    expect(turn.outputs).toEqual([]);
    // Nothing the model wrote stands in for the output.
    expect(history.getMessages().map((m) => m.content)).toEqual(["q"]);
  });

  it("fails with output-invalid once the retries are spent on refused values, with the last error", async () => {
    const history = keptHistory();
    let n = 0;
    const turn = toolTurn(toolOfFn(({ query }) => built(query)), { validate: () => ({ ok: false, error: `refused ${++n}` }), retries: 1 });
    const model = scripted([{ steps: [[{ tool: "build", input: { query: "a" } }], [{ tool: "build", input: { query: "b" } }], [{ tool: "build", input: { query: "c" } }]] }]);

    const err = await runTurn(history, "q", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput }).catch((e) => e);

    expect(err).toMatchObject({ kind: "turn-output", code: "output-invalid", attempts: 2, lastError: "refused 2" });
  });

  it("text and refused values share the same retries", async () => {
    const history = keptHistory();
    const turn = toolTurn(toolOfFn(({ query }) => built(query)), { validate: () => ({ ok: false, error: "no" }), retries: 1 });
    const model = scripted([{ steps: [[{ tool: "build", input: { query: "a" } }]], text: "x" }, { steps: [], text: "y" }]);

    const err = await runTurn(history, "q", { model: "m" as never, tools: turn.tools, system: SYSTEM, generateTextFn: model.fn, output: turn.output, onOutput: turn.onOutput }).catch((e) => e);

    expect(err).toMatchObject({ code: "output-missing", attempts: 2 });
  });

  it("fails with output-tool-unavailable, before any model call, when the tool isn't offered", async () => {
    const history = keptHistory();
    const probe = createOutputProbe();
    const model = scripted([{ steps: [], text: "x" }]);

    const err = await runTurn(history, "q", { model: "m" as never, tools: {}, system: SYSTEM, generateTextFn: model.fn, output: { mode: "tool", tool: "build", probe, retries: 2 } }).catch((e) => e);

    expect(err).toMatchObject({ code: "output-tool-unavailable", attempts: 0, lastError: 'the tool "build" isn\'t offered on this turn' });
    expect(model.calls()).toBe(0);
  });

  it("a staged confirmation ends the turn as it does today: the pending note, no output", async () => {
    const history = keptHistory();
    const turn = toolTurn(toolOfFn(({ query }) => built(query)));
    const staging = { description: "d", inputSchema: z.object({}), execute: async () => ({ ok: false, pendingConfirmation: true, token: "TOK1", summary: "s" }) } as unknown as Tool;
    const tools = { ...turn.tools, stage: staging };
    let noted = false;
    const fn = async (params: { tools: Record<string, Tool>; onStepEnd?: (s: StepInfo) => void }) => {
      const output = await (params.tools.stage!.execute as (x: unknown, o: unknown) => Promise<unknown>)({}, {});
      params.onStepEnd?.({ toolCalls: [{ toolCallId: "1", toolName: "stage", input: {} }], toolResults: [{ toolCallId: "1", toolName: "stage", output }], content: [] });
      return { text: "" };
    };

    const text = await runTurn(history, "q", { model: "m" as never, tools, system: SYSTEM, generateTextFn: fn, output: turn.output, onOutput: turn.onOutput, onPendingNote: () => (noted = true) });

    expect(text).toBe(CORE_MESSAGES["core.pending.note"]!);
    expect(noted).toBe(true);
    expect(turn.outputs).toEqual([]);
    expect(history.getMessages().at(-1)!.content).toBe("[REQ:TOK1]");
  });
});

describe("runTurn with output: { schema }", () => {
  const schema = z.object({ query: z.string() });
  type ObjectCall = { messages: ModelMessage[]; instructions: string; schema: unknown };

  /** A fake constrained call playing `answers` in order. */
  function constrained(answers: Array<{ ok: true; value: unknown; text: string } | { ok: false; error: string; text: string }>) {
    const seen: ObjectCall[] = [];
    const fn = async (params: ObjectCall) => {
      seen.push(params);
      return answers[seen.length - 1] ?? { ok: false as const, error: "nothing", text: "" };
    };
    return { fn, seen };
  }

  it("with no tools, one constrained call is the whole turn", async () => {
    const history = keptHistory();
    const outputs: unknown[] = [];
    const object = constrained([{ ok: true, value: { query: "dante" }, text: '{"query":"dante"}' }]);
    let textCalls = 0;

    const text = await runTurn(history, "books by dante", {
      model: "m" as never,
      tools: {},
      system: SYSTEM,
      generateTextFn: async () => {
        textCalls++;
        return { text: "x" };
      },
      generateObjectFn: object.fn,
      output: { mode: "schema", schema, retries: 2 },
      onOutput: (output, attempts) => outputs.push({ output, attempts }),
    });

    expect(textCalls).toBe(0);
    expect(object.seen).toHaveLength(1);
    expect(object.seen[0]!.schema).toBe(schema);
    expect(object.seen[0]!.instructions).toBe(SYSTEM);
    expect(object.seen[0]!.messages).toEqual([{ role: "user", content: "books by dante" }]);
    expect(outputs).toEqual([{ output: { mode: "schema", value: { query: "dante" } }, attempts: 1 }]);
    expect(text).toBe(JSON.stringify({ query: "dante" }, null, 2));
    expect(history.getMessages().map((m) => m.content)).toEqual(["books by dante", JSON.stringify({ query: "dante" }, null, 2)]);
  });

  it("a JSON that doesn't parse goes back to the model with its error", async () => {
    const history = keptHistory();
    const outputs: Array<{ attempts: number }> = [];
    const object = constrained([
      { ok: false, error: "response did not match schema", text: '{"query":' },
      { ok: true, value: { query: "dante" }, text: '{"query":"dante"}' },
    ]);

    await runTurn(history, "q", { model: "m" as never, tools: {}, system: SYSTEM, generateObjectFn: object.fn, output: { mode: "schema", schema, retries: 2 }, onOutput: (_o, attempts) => outputs.push({ attempts }) });

    const second = object.seen[1]!.messages;
    expect(second.slice(-2)).toEqual([
      { role: "assistant", content: '{"query":' },
      { role: "user", content: "That answer isn't valid: response did not match schema. Answer again with JSON matching the schema." },
    ]);
    expect(outputs).toEqual([{ attempts: 2 }]);
  });

  it("the validator refuses, the model is told, the next value is accepted", async () => {
    const history = keptHistory();
    const object = constrained([
      { ok: true, value: { query: "titel ~ 'x'" }, text: "1" },
      { ok: true, value: { query: "title ~ 'x'" }, text: "2" },
    ]);
    const validate: Validate = (v) => ((v as { query: string }).query.startsWith("title") ? { ok: true } : { ok: false, error: 'no field "titel"' });
    const outputs: unknown[] = [];

    await runTurn(history, "q", { model: "m" as never, tools: {}, system: SYSTEM, generateObjectFn: object.fn, output: { mode: "schema", schema, validate, retries: 2 }, onOutput: (o) => outputs.push(o) });

    expect(lastUser(object.seen[1]!.messages)).toBe('That answer isn\'t valid: no field "titel". Answer again with JSON matching the schema.');
    expect(outputs).toEqual([{ mode: "schema", value: { query: "title ~ 'x'" } }]);
  });

  it("spent retries: output-missing when it never parsed, output-invalid when the validator had the last word", async () => {
    const parseFail = { ok: false as const, error: "bad json", text: "{" };
    const missing = await runTurn(keptHistory(), "q", { model: "m" as never, tools: {}, system: SYSTEM, generateObjectFn: constrained([parseFail, parseFail]).fn, output: { mode: "schema", schema, retries: 1 } }).catch((e) => e);
    expect(missing).toMatchObject({ code: "output-missing", attempts: 2, lastError: "bad json" });

    const ok = { ok: true as const, value: { query: "x" }, text: "x" };
    const invalid = await runTurn(keptHistory(), "q", { model: "m" as never, tools: {}, system: SYSTEM, generateObjectFn: constrained([parseFail, ok]).fn, output: { mode: "schema", schema, validate: () => ({ ok: false, error: "nope" }), retries: 1 } }).catch((e) => e);
    expect(invalid).toMatchObject({ code: "output-invalid", attempts: 2, lastError: "nope" });
  });

  it("with tools, the tools run first, then a constrained call with no tools reads what they returned", async () => {
    const history = keptHistory();
    const lookup = toolOfFn(() => ({ ok: true, fields: ["title"] }));
    const model = scripted([{ steps: [[{ tool: "lookup", input: { query: "t" } }]], text: "Your query is (title ~ 'x')" }]);
    const object = constrained([{ ok: true, value: { query: "(title ~ 'x')" }, text: "{}" }]);

    await runTurn(history, "q", { model: "m" as never, tools: { lookup }, system: SYSTEM, generateTextFn: model.fn, generateObjectFn: object.fn, output: { mode: "schema", schema, retries: 2 } });

    expect(model.calls()).toBe(1);
    const read = object.seen[0]!.messages;
    expect(toolResultsIn(read)).toEqual([{ type: "json", value: { ok: true, fields: ["title"] } }]);
    expect(read.at(-2)).toEqual({ role: "assistant", content: "Your query is (title ~ 'x')" });
    expect(read.at(-1)).toEqual({ role: "user", content: "Now give the final answer as JSON matching the schema." });
    expect(history.getMessages().at(-1)!.calls?.map((c) => c.toolName)).toEqual(["lookup"]);
  });

  it("the constrained call is a silent one: the caller is told when it starts and ends", async () => {
    const events: boolean[] = [];
    const object = constrained([{ ok: true, value: { query: "x" }, text: "{}" }]);
    await runTurn(keptHistory(), "q", { model: "m" as never, tools: {}, system: SYSTEM, generateObjectFn: object.fn, output: { mode: "schema", schema, retries: 0 }, onSilentCall: (running) => events.push(running) });
    expect(events).toEqual([true, false]);
  });
});
