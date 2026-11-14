/**
 * What a turn returns, as the instance's config decides it (`MercuryConfig.output`):
 * the model's text (the default), the result of one tool that ends the turn,
 * or an object matching a schema. This file holds the config's shape, its
 * resolution at startup (a contradiction stops the instance) and the verdict
 * on a value the model gave; the turn itself runs it in `agent-turn.ts`.
 */
import type { FlexibleSchema } from "ai";
import { channelOutputs, type ChannelPlugin, type OutputMode } from "@mercury-fw/channel-types";
import type { Plugin } from "@mercury-fw/plugin-types";

/** One of a plugin's tools, named by the plugin object and the tool's name (see `toolOf`). */
export type ToolRef = { plugin: Plugin; name: string };

/** A validator's verdict on an output: accepted, or refused with the exact error the model is told. */
export type OutputVerdict = { ok: true } | { ok: false; error: string };

/** Checks an output the model gave, beyond its shape (a plugin's grammar, say); sync or async. */
export type Validate = (value: unknown) => OutputVerdict | Promise<OutputVerdict>;

/**
 * What a turn returns: `"text"` (the default, as when left out); `{ tool }`,
 * the result of that tool ends the turn, with no further model step;
 * `{ schema }`, an object matching the schema. `validate` checks the value
 * further, `retries` is how many times the model is told the exact error and
 * tries again (2 when left out) before the turn fails with a
 * `TurnOutputError`.
 */
export type TurnOutputConfig =
  | "text"
  | { tool: ToolRef; validate?: Validate; retries?: number }
  | { schema: FlexibleSchema<unknown>; validate?: Validate; retries?: number };

/** The output a turn runs with, once resolved: never text, which needs nothing. */
export type ResolvedOutput =
  | { mode: "tool"; plugin: string; tool: string; validate?: Validate; retries: number }
  | { mode: "schema"; schema: FlexibleSchema<unknown>; validate?: Validate; retries: number };

/** How many times the model tries again when `retries` is left out. */
const DEFAULT_RETRIES = 2;

/** The tool `name` of `plugin`, for `output: { tool }`. */
export function toolOf(plugin: Plugin, name: string): ToolRef {
  return { plugin, name };
}

/**
 * `output` as a turn runs it, or `undefined` for text. Throws, stopping the
 * instance, when the config contradicts itself: a tool whose plugin isn't in
 * `plugins`, `retries` that isn't a whole number from 0 up, a channel that
 * doesn't handle the output (`ChannelPlugin.outputs`).
 */
export function resolveOutput(
  output: TurnOutputConfig | undefined,
  instance: { plugins: Plugin[]; channels: ChannelPlugin[] },
): ResolvedOutput | undefined {
  if (output === undefined || output === "text") return undefined;
  const retries = output.retries ?? DEFAULT_RETRIES;
  if (!Number.isInteger(retries) || retries < 0) throw new Error(`output: retries must be a whole number from 0 up, not ${retries}`);
  const mode: OutputMode = "tool" in output ? "tool" : "schema";
  for (const channel of instance.channels) {
    if (!channelOutputs(channel).includes(mode)) throw new Error(`channel "${channel.name}" doesn't handle the "${mode}" output`);
  }
  const validate = output.validate === undefined ? {} : { validate: output.validate };
  if ("tool" in output) {
    const { plugin, name } = output.tool;
    if (!instance.plugins.includes(plugin)) {
      throw new Error(`output: the tool "${name}" belongs to the plugin "${plugin.name}", which isn't in plugins`);
    }
    return { mode: "tool", plugin: plugin.name, tool: name, ...validate, retries };
  }
  return { mode: "schema", schema: output.schema, ...validate, retries };
}

/**
 * The verdict on `value`, an output the model gave: refused when it's a
 * tool's result that says it failed (`{ ok: false }`, the tool's own error,
 * as the model already sees it), otherwise `validate`'s, accepted without
 * one. A validator that throws refuses it with its message.
 */
export async function acceptOutput(value: unknown, validate: Validate | undefined, opts: { toolResult?: boolean } = {}): Promise<OutputVerdict> {
  if (opts.toolResult && typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false) {
    return { ok: false, error: `the tool failed: ${JSON.stringify(value)}` };
  }
  if (validate === undefined) return { ok: true };
  try {
    return await validate(value);
  } catch (err) {
    return { ok: false, error: `the validator failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
