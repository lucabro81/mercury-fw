/**
 * A session's conversation with files: the window of `conversation-window`
 * keeps the messages, and what doesn't need to sit in the model's context
 * goes to the session's files (`session-files.ts`), the model getting a
 * reference instead.
 *
 * - `toolOutput`: an output longer than `outputs.overChars` is written to a
 *   file; the model reads the file's ref, size and first lines.
 * - `pastCall`: a past call whose output went to a file points at it. The
 *   core keeps no call id, so a call is told apart by its tool and input: a
 *   call run again with the same input points at its latest run's file, and
 *   at none when that run stayed whole.
 * - `turnIndex`: the session's files, one line each, in front of every
 *   message, the oldest past `index.maxEntries` folded into one line.
 * - `placeLayers` (with `layers: true`): each session layer's blocks go to a
 *   file, the system prompt keeping one line saying where; a layer already in
 *   a file, word for word, points at it.
 *
 * Used by: `index.ts`, which opens one per session.
 */
import { createHash } from "node:crypto";
import type { Conversation, LayerBlocks } from "@mercury-fw/plugin-types";
import type { JSONValue } from "ai";
import type { Window } from "@mercury-fw/conversation-window";
import type { SessionFiles } from "./session-files.ts";

/** The plugin's own tools: their outputs are never moved to a file, or reading a long file would write another. */
export const OWN_TOOLS = new Set(["read_context_file", "search_context_files"]);

/** How many lines of a moved output the model reads at once. */
const HEAD_LINES = 20;
/** How many characters of them at most. */
const HEAD_CHARS = 1000;
/** How many characters of a call's input a file's label shows. */
const LABEL_INPUT_CHARS = 80;
/**
 * How many characters of each string of a call's input tell its calls apart.
 * Below the core's own cut of the inputs it records (500), so a call is found
 * from what the core kept of it.
 */
const KEY_STRING_CHARS = 200;

/** What the model reads with a moved output. Model-facing, so in English. */
export const OUTPUT_NOTE = (ref: string) =>
  `The whole output is in the file ${ref}: read it in pieces with read_context_file, or search it with search_context_files, before answering on what isn't in the head.`;

/** What the model reads of a past call whose output is in a file. Model-facing, so in English. */
export const PAST_CALL_NOTE = (ref: string) =>
  `What this call returned (its latest run with this input) is in the file ${ref}: read it with read_context_file instead of running the call again.`;

/** What the system prompt keeps of a layer moved to a file. Model-facing, so in English. */
export const LAYER_NOTE = (layer: string, ref: string) => `The ${layer} context is in the file ${ref}: read it with read_context_file when it may help.`;

export type FilesConversationOptions = {
  files: SessionFiles;
  /** The window keeping the messages. */
  window: Window;
  /** Outputs longer than `overChars` go to a file; `false`, they stay whole. */
  outputs: { overChars: number } | false;
  /** Whether the session layers go to files. */
  layers?: boolean;
  /** How many files the index lists one by one. */
  index: { maxEntries: number };
};

/** `text` cut at `max` characters, with "…" when it was longer. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `value` with every string cut at `KEY_STRING_CHARS`, objects and arrays walked. */
function keyed(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, KEY_STRING_CHARS);
  if (Array.isArray(value)) return value.map(keyed);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keyed(v)]));
  return value;
}

/** What tells a call apart: its tool and its input. */
function callKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(keyed(input)) ?? ""}`;
}

/** The first lines of `text`, at most `HEAD_CHARS` characters. */
function headOf(text: string): string {
  return cut(text.split("\n").slice(0, HEAD_LINES).join("\n"), HEAD_CHARS);
}

/** How a file's size reads in the index. */
function linesLabel(lines: number): string {
  return lines === 1 ? "1 line" : `${lines} lines`;
}

/** The conversation; see the module comment. */
export function createFilesConversation(opts: FilesConversationOptions): Conversation {
  const { files, window, outputs } = opts;
  // The latest run of each call (by `callKey`) in this process: its file, or null when it stayed whole.
  const latest = new Map<string, string | null>();

  const toolOutput: Conversation["toolOutput"] = async (call, content) => {
    if (outputs === false || OWN_TOOLS.has(call.toolName)) return content;
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    const key = callKey(call.toolName, call.input);
    if (text === undefined || text.length <= outputs.overChars) {
      latest.set(key, null);
      return content;
    }
    const label = `${call.toolName} ${cut(JSON.stringify(call.input) ?? "", LABEL_INPUT_CHARS)}`;
    const ref = await files.write("outputs", text, label, key);
    latest.set(key, ref);
    return { file: ref, lines: text.split("\n").length, chars: text.length, head: headOf(text), note: OUTPUT_NOTE(ref) };
  };

  /** `layer`'s blocks in a file, the one already holding them when there is one. */
  async function layerFile({ layer, blocks }: LayerBlocks): Promise<string> {
    const text = blocks.join("\n\n");
    const key = `layer:${layer}:${createHash("sha256").update(text).digest("hex")}`;
    return files.refFor(key) ?? files.write("layers", text, `${layer} layer`, key);
  }

  return {
    getMessages: () => window.getMessages(),
    addUserMessage: (content, context) => window.addUserMessage(content, context),
    addAssistantMessage: (content, calls) => window.addAssistantMessage(content, calls),
    replaceLastAssistantMessage: (content) => window.replaceLastAssistantMessage(content),
    getCharCount: () => window.getCharCount(),
    getCapturable: () => window.getCapturable(),
    ...(outputs === false ? {} : { toolOutput }),
    ...(opts.layers === true
      ? {
          placeLayers: async ({ session }) => ({
            session: await Promise.all(session.map(async (l) => ({ layer: l.layer, blocks: [LAYER_NOTE(l.layer, await layerFile(l))] }))),
          }),
        }
      : {}),
    pastCall: (call, shown): JSONValue => {
      const key = callKey(call.toolName, call.input);
      const ref = latest.has(key) ? latest.get(key) : files.refFor(key);
      if (ref === undefined || ref === null) return shown;
      return { ...(shown as Record<string, JSONValue>), file: ref, note: PAST_CALL_NOTE(ref) };
    },
    turnIndex: () => {
      const entries = files.entries();
      if (entries.length === 0) return undefined;
      const folded = Math.max(0, entries.length - opts.index.maxEntries);
      return [
        "<context-files>",
        "Files of this conversation (open them with read_context_file, search them with search_context_files):",
        ...(folded === 0 ? [] : [`- ${folded} earlier files: find them with search_context_files`]),
        ...entries.slice(folded).map((e) => `- ${e.ref} — ${e.label} (${linesLabel(e.lines)})`),
        "</context-files>",
      ].join("\n");
    },
  };
}
