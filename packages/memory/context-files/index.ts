/**
 * `@mercury-fw/context-files`: a context strategy that keeps part of each
 * conversation in files instead of in front of the model, which reads them
 * in pieces with its own tools. What goes to files is declared in its
 * options: tool outputs over a size, the older messages past the window's
 * size (in place of a summary), the session layers.
 *
 * An app declares it in `plugins` and names it as a context profile's
 * `conversation`, in place of `conversationWindow()`: the window and the
 * reopening of a conversation are `conversation-window`'s, and so is
 * `recall_tool_calls`. The files live in the plugin's data folder, one folder
 * per session, removed when the session closes.
 */
import { createWindow, createRecallToolCalls, createSummarizer, DEFAULT_MAX_CHARS, readTail, RECALL_PROMPT_FRAGMENT, resumeBudget, resumeConversation } from "@mercury-fw/conversation-window";
import type { EarlierSummaries } from "@mercury-fw/conversation-window";
import { parseSkill, PLUGIN_API_VERSION, type ConversationOpen, type Plugin, type PluginNeed } from "@mercury-fw/plugin-types";
import { readFileSync } from "node:fs";
import { createFilesConversation } from "./conversation.ts";
import { createFilesWindow } from "./files-window.ts";
import { openSessionFiles, type SessionFiles } from "./session-files.ts";
import { createContextFileTools } from "./tools.ts";

/** What a window does past its size: move the older messages to a file, fold them into a summary, or drop them. */
export type ContextFilesOverflow = "files" | "summarize" | "truncate";

export type ContextFilesOptions = {
  /** How many characters of messages the window holds before it shortens what came before: 60000 when absent. */
  maxChars?: number;
  /** How the window shortens: `files` (the default) moves the older messages to a history file; `summarize` and `truncate` as `conversationWindow`. */
  overflow?: ContextFilesOverflow;
  /** How many exchanges always stay in the window with `overflow: "files"`, the current one included: 4 when absent. */
  keepRecent?: number;
  /** Tool outputs longer than `overChars` (4000 when absent) go to a file; `false`, every output stays whole. */
  outputs?: { overChars?: number } | false;
  /** Whether the session layers go to files, the system prompt keeping one line for each. */
  layers?: boolean;
  /** How many files the index in front of each message lists one by one (`maxEntries`, 30 when absent); the oldest are folded into one line. */
  index?: { maxEntries?: number };
  /** As `conversationWindow`'s: how much of a reopened conversation comes back, or `false` never to read the archive. */
  reopen?: { maxChars?: number } | false;
  /** As `conversationWindow`'s: what reads the summaries of a reopened conversation's older part. */
  earlier?: EarlierSummaries;
};

/** The plugin's texts, in English. */
export const CONTEXT_FILES_MESSAGES = {
  "context-files.status.read": "Reading back what I saved…",
  "context-files.status.search": "Looking through what I saved…",
  "context-files.status.recall": "Checking my memory…",
};

/** What the model is always told about the files. Model-facing, so in English. */
export const CONTEXT_FILES_PROMPT_FRAGMENT = [
  "Part of this conversation is kept in files, listed in front of each message (<context-files>): long tool outputs, older messages, some of your context.",
  "Never answer from what a file probably holds: read it with read_context_file or search it with search_context_files (the context-files skill says how).",
].join("\n");

const contextFilesSkill = parseSkill(readFileSync(new URL("./skills/context-files/SKILL.md", import.meta.url), "utf8"));

/** Whether `n` is a whole number from `min` up. */
function wholeFrom(n: number, min: number): boolean {
  return Number.isInteger(n) && n >= min;
}

/** Throws `contextFiles: <name> must be …` unless `n` is a whole number from `min` up. */
function check(n: number, min: number, name: string): void {
  if (!wholeFrom(n, min)) throw new Error(`contextFiles: ${name} must be a whole number ${min === 0 ? "from 0 up" : "above 0"}`);
}

/** The context-files plugin; see the module comment. Throws on options that can't be. */
export function contextFiles(options: ContextFilesOptions = {}): Plugin {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  check(maxChars, 1, "maxChars");
  const overflow = options.overflow ?? "files";
  if (!["files", "summarize", "truncate"].includes(overflow)) throw new Error('contextFiles: overflow must be "files", "summarize" or "truncate"');
  const keepRecent = options.keepRecent ?? 4;
  check(keepRecent, 1, "keepRecent");
  const outputs = options.outputs === false ? false : { overChars: options.outputs?.overChars ?? 4000 };
  if (outputs !== false) check(outputs.overChars, 1, "outputs.overChars");
  const maxEntries = options.index?.maxEntries ?? 30;
  check(maxEntries, 1, "index.maxEntries");
  const reopen = options.reopen;
  if (reopen !== false && reopen?.maxChars !== undefined) check(reopen.maxChars, 0, "reopen.maxChars");
  const ownReopenChars = reopen === false ? 0 : (reopen?.maxChars ?? Math.floor(maxChars / 2));
  const needs: PluginNeed[] = reopen === false ? [] : ["conversationStore"];

  return {
    apiVersion: PLUGIN_API_VERSION,
    name: "context-files",
    description:
      "Keeps each conversation for the model with part of it in files (long tool outputs, older messages, some context), which the model reads in pieces, and brings back a conversation its person reopens.",
    actsAs: "anyone",
    needs,
    messages: CONTEXT_FILES_MESSAGES,
    systemPromptFragment: `${CONTEXT_FILES_PROMPT_FRAGMENT}\n\n${RECALL_PROMPT_FRAGMENT}`,
    skills: [contextFilesSkill],
    build: (ctx) => {
      const root = ctx.dataDir;
      if (root === undefined) throw new Error("contextFiles: no data folder to keep the files in");
      // The resumption is conversation-window's: its log lines say whose.
      const log = (m: string) => ctx.log(m.replace("[conversation-window]", "[context-files]"));
      const summarize = createSummarizer(ctx.model);
      const earlier = options.earlier;
      /** The files of each session whose conversation is open. */
      const open = new Map<string, Promise<SessionFiles>>();

      /** What a reopening brings back for `req`, if anything. */
      async function resumedFor(req: ConversationOpen) {
        const store = ctx.conversations;
        if (reopen === false || store === undefined || req.person === undefined || req.reopen === undefined) return undefined;
        const person = req.person.key;
        return resumeConversation(
          { userId: person, sessionKey: req.sessionKey, maxChars: resumeBudget(req.reopen, ownReopenChars) },
          {
            readTail: (q) => readTail(store, q),
            ...(earlier === undefined ? {} : { readSummaries: (q: { sessionKey: string }) => earlier.summariesOf({ person, sessionKey: q.sessionKey }) }),
            log,
          },
          req.timeZone,
        );
      }

      /** The files of `sessionKey`: its open conversation's, else read from its folder. */
      function filesOf(sessionKey: string): Promise<SessionFiles> {
        return open.get(sessionKey) ?? openSessionFiles(root!, sessionKey);
      }

      return {
        conversation: {
          open: async (req) => {
            const pending = openSessionFiles(root, req.sessionKey);
            open.set(req.sessionKey, pending);
            const files = await pending;
            const resumed = await resumedFor(req);
            const window =
              overflow === "files"
                ? createFilesWindow({ files, maxChars, keepRecent, ...(resumed === undefined ? {} : { resumed }) })
                : createWindow({ summarize, maxChars, overflow, ...(resumed === undefined ? {} : { resumed }) });
            return createFilesConversation({ files, window, outputs, ...(options.layers === true ? { layers: true } : {}), index: { maxEntries } });
          },
          close: (sessionKey) => {
            const files = filesOf(sessionKey);
            open.delete(sessionKey);
            void files
              .then((f) => f.remove())
              .catch((err) => log(`[context-files] couldn't remove the files of ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`));
          },
        },
        sessionTools: (sctx) => {
          const files = {
            read: async (...args: Parameters<SessionFiles["read"]>) => (await filesOf(sctx.sessionKey)).read(...args),
            search: async (...args: Parameters<SessionFiles["search"]>) => (await filesOf(sctx.sessionKey)).search(...args),
          };
          const toolLog = ctx.toolLog;
          return {
            ...createContextFileTools(files),
            ...(toolLog === undefined || sctx.person === null ? {} : createRecallToolCalls({ toolLog, sessionKey: sctx.sessionKey, person: sctx.person.key })),
          };
        },
        toolStatusDescribers: {
          read_context_file: (_input, t) => t("context-files.status.read"),
          search_context_files: (_input, t) => t("context-files.status.search"),
          recall_tool_calls: (_input, t) => t("context-files.status.recall"),
        },
      };
    },
  };
}
