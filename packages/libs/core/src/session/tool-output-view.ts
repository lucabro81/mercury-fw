/**
 * The conversation's own view of tool outputs inside a turn (the contract's
 * `Conversation.toolOutput`, #414): what the model reads in place of each
 * output, while everything else the turn hands on (the steps the channels,
 * the tool log and the traces see, the calls the history records) keeps the
 * output itself.
 *
 * `withToolOutputView` wraps the turn's tools: each output is kept by its call
 * id, and the model gets what the view makes of it, with the fields the core
 * reads put back (`viewOf`, which a confirmed action's result goes through
 * too). A staged confirmation and a login request pass as they are: the turn
 * stops on them. `restoreStep` gives a step its outputs back.
 *
 * Used by: `agent-turn.ts` (`runTurn`), when the session's conversation has a view.
 */
import type { Tool } from "ai";
import type { StepInfo } from "./step-info.ts";

/** The view a conversation has of tool outputs: the contract's `Conversation.toolOutput`. */
export type ToolOutputView = (call: { toolName: string; toolCallId: string; input: unknown }, content: unknown) => unknown | Promise<unknown>;

/** The fields of an output the core reads: never handed to the view, always put back on what it returns. */
const CONTROL_FIELDS = ["ok", "error", "displayRef", "shown"] as const;

/** Whether `value` is a plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the turn stops on `output`: a staged confirmation or a login request. */
function stopsTheTurn(output: unknown): boolean {
  return isRecord(output) && (output.pendingConfirmation === true || output.loginRequired === true);
}

/** `output` split into the fields the core reads and the rest, the view's `content`. */
function split(output: unknown): { control: Record<string, unknown>; content: unknown } {
  if (!isRecord(output)) return { control: {}, content: output };
  const control: Record<string, unknown> = {};
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if ((CONTROL_FIELDS as readonly string[]).includes(key)) control[key] = value;
    else content[key] = value;
  }
  return { control, content };
}

/** What the model reads: the view's value with `control` put back over it, a value that isn't an object under `content`. */
function join(control: Record<string, unknown>, viewed: unknown): unknown {
  if (Object.keys(control).length === 0) return viewed;
  return isRecord(viewed) ? { ...viewed, ...control } : { ...control, content: viewed };
}

/** What tells the turn a view failed: the tool and the error. */
export type ViewFailed = (toolName: string, error: string) => void;

/**
 * What the model reads of `output`, a result of `call`: `output` itself when
 * the turn stops on it, else `view`'s value with the fields the core reads put
 * back. A view that fails gives `output` itself, and `onFailed` hears it.
 */
export async function viewOf(
  view: ToolOutputView,
  call: { toolName: string; toolCallId: string; input: unknown },
  output: unknown,
  onFailed: ViewFailed,
): Promise<unknown> {
  if (stopsTheTurn(output)) return output;
  const { control, content } = split(output);
  try {
    return join(control, await view(call, content));
  } catch (err) {
    onFailed(call.toolName, err instanceof Error ? err.message : String(err));
    return output;
  }
}

/** `tools`, each output going through `view` (see `viewOf`) for the model and kept as it was in `originals` by call id. */
export function withToolOutputView(
  tools: Record<string, Tool>,
  view: ToolOutputView,
  originals: Map<string, unknown>,
  onFailed: ViewFailed,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    const { execute } = tool;
    out[toolName] =
      execute === undefined
        ? tool
        : ({
            ...tool,
            execute: async (input: unknown, options: { toolCallId: string }) => {
              const output = await (execute as (i: unknown, o: unknown) => unknown)(input, options);
              originals.set(options.toolCallId, output);
              return viewOf(view, { toolName, toolCallId: options.toolCallId, input }, output, onFailed);
            },
          } as Tool);
  }
  return out;
}

/** `step` with each tool result's output as the tool returned it, where `originals` kept one. */
export function restoreStep(step: StepInfo, originals: Map<string, unknown>): StepInfo {
  return {
    ...step,
    toolResults: step.toolResults.map((r) => (originals.has(r.toolCallId) ? { ...r, output: originals.get(r.toolCallId) } : r)),
  };
}
