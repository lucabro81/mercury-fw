/**
 * What the history keeps of a turn's tool calls: each call with its input and
 * a reduced result — how it went, what it ran, how many items it found, the
 * list it produced, its error — never the data. The history stores these next
 * to the answer (`history.ts`) and `agent-turn.ts` hands them back to the
 * model on later turns as real tool-call and tool-result messages
 * (`callMessages`). Without them every past answer looks written from memory,
 * and the more of those a conversation has, the more the model stops calling
 * tools and invents the data (#351); a plain-text trace in the answer worked
 * too, but the model learned to write it, real tool messages it can't. A
 * `read_skill` call gets a note of its own: what it returned is the skill's
 * text, and with the generic note the model took the skill for still loaded
 * and guessed its commands instead of reading it again (#356).
 */
import type { ModelMessage } from "ai";
import type { StepInfo } from "./step-info.ts";
import { READ_SKILL_TOOL } from "./read-skill-tool.ts";

/** A call's result as the history keeps it. `results`/`found` only when the count can be told; `error` only for a failed call. */
export type CallResult = {
  ok: boolean;
  ran: string;
  results?: number;
  found?: false;
  displayRef?: string;
  error?: string;
};

/** One tool call of a past turn: its tool, its input (long strings cut), its reduced result. */
export type CallRecord = { toolName: string; input: unknown; result: CallResult };

/** What every reduced result tells the model about the data it no longer has. Model-facing, so in English. */
export const HISTORY_CALL_NOTE =
  "Data not kept in the conversation history. Run the tool again for current data, or call recall_tool_calls for what it returned then.";

/** What the reduced result of a `read_skill` call tells the model instead: the skill isn't loaded anymore. Model-facing, so in English. */
export const SKILL_CALL_NOTE =
  "The skill's text is not kept in the conversation history: call read_skill again to load it before using its tools.";

/** How much of what a call ran, and of its error, the history keeps. */
const SUMMARY_MAX = 300;
/** How long a string in a call's input may be in the history (a wiki note's body, for instance). */
const INPUT_STRING_MAX = 500;

/** `text` cut at `max` characters, with "…" when it was longer. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `value` with every string longer than `INPUT_STRING_MAX` cut, objects and arrays walked. */
function cutStrings(value: unknown): unknown {
  if (typeof value === "string") return cut(value, INPUT_STRING_MAX);
  if (Array.isArray(value)) return value.map(cutStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, cutStrings(v)]));
  }
  return value;
}

/** A plain object's fields, or undefined for anything else. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** What a call ran: a CLI tool's `command`, the JSON input for any other tool, cut. */
function ranOf(input: unknown): string {
  const command = fieldsOf(input)?.command;
  return cut(typeof command === "string" ? command : (JSON.stringify(input ?? {}) ?? ""), SUMMARY_MAX);
}

/**
 * How many items `output` holds, when that can be told without knowing the
 * tool: an array, a `data` array, or the first array field of the result (or
 * of its `data`). Undefined otherwise: a page read, plain text.
 */
function countOf(output: unknown): number | undefined {
  if (Array.isArray(output)) return output.length;
  const fields = fieldsOf(output);
  if (fields === undefined) return undefined;
  const data = "data" in fields ? fields.data : output;
  if (Array.isArray(data)) return data.length;
  const first = Object.values(fieldsOf(data) ?? {}).find(Array.isArray);
  return first === undefined ? undefined : first.length;
}

/** An error, whatever shape it came in, as text. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
}

/** The reduced result of `call`, from its result if it has one, else from its `tool-error` part, if any. */
function resultOf(call: StepInfo["toolCalls"][number], step: StepInfo): CallResult {
  const ran = ranOf(call.input);
  const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
  if (result === undefined) {
    const failure = step.content.find((part) => part.type === "tool-error" && part.toolCallId === call.toolCallId);
    return failure === undefined ? { ok: false, ran } : { ok: false, ran, error: cut(errorText(failure.error), SUMMARY_MAX) };
  }
  const fields = fieldsOf(result.output);
  if (fields?.ok === false) {
    return fields.error === undefined ? { ok: false, ran } : { ok: false, ran, error: cut(errorText(fields.error), SUMMARY_MAX) };
  }
  const reduced: CallResult = { ok: true, ran };
  const count = countOf(result.output);
  if (count !== undefined) {
    reduced.results = count;
    if (count === 0) reduced.found = false;
  }
  if (typeof fields?.displayRef === "string") reduced.displayRef = fields.displayRef;
  return reduced;
}

/** Every tool call of a turn's steps, in order, as the history keeps it. */
export function callRecords(steps: StepInfo[]): CallRecord[] {
  return steps.flatMap((step) =>
    step.toolCalls.map((call) => ({ toolName: call.toolName, input: cutStrings(call.input), result: resultOf(call, step) })),
  );
}

/**
 * `records` as the model reads them back: the assistant's tool calls, then a
 * tool message with each one's reduced result and `HISTORY_CALL_NOTE`
 * (`SKILL_CALL_NOTE` for a `read_skill` call). Ids are
 * `<idPrefix>-<n>`, so the caller keeps them unique within a prompt. Nothing
 * for no records.
 */
export function callMessages(records: CallRecord[], idPrefix: string): ModelMessage[] {
  if (records.length === 0) return [];
  const id = (n: number) => `${idPrefix}-${n}`;
  return [
    {
      role: "assistant",
      content: records.map((r, n) => ({ type: "tool-call" as const, toolCallId: id(n), toolName: r.toolName, input: r.input })),
    },
    {
      role: "tool",
      content: records.map((r, n) => ({
        type: "tool-result" as const,
        toolCallId: id(n),
        toolName: r.toolName,
        output: { type: "json" as const, value: { ...r.result, note: r.toolName === READ_SKILL_TOOL ? SKILL_CALL_NOTE : HISTORY_CALL_NOTE } },
      })),
    },
  ];
}
