import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, type ConversationStore, type PluginRuntimeContext, type StoredMessage, type ToolLog } from "@mercury-fw/plugin-types";
import { contextFiles } from "./index.ts";
import { sessionFolder } from "./session-files.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "context-files-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/** What the plugin's `build` gets: the data folder, and the store and tool log given. */
function ctxWith(opts: { store?: ConversationStore; toolLog?: ToolLog; noDataDir?: true; daily?: unknown[] } = {}) {
  const logs: string[] = [];
  const ctx = {
    ...(opts.daily === undefined ? {} : { daily: (...args: unknown[]) => void opts.daily!.push(args) }),
    model: {} as never,
    log: (m: string) => logs.push(m),
    ...(opts.noDataDir ? {} : { dataDir }),
    ...(opts.store === undefined ? {} : { conversations: opts.store }),
    ...(opts.toolLog === undefined ? {} : { toolLog: opts.toolLog }),
  } as unknown as PluginRuntimeContext;
  return { ctx, logs };
}

/** The plugin's contributions built on `ctx` (the data folder by default). */
async function built(plugin: ReturnType<typeof contextFiles>, ctx: PluginRuntimeContext = ctxWith().ctx) {
  return await plugin.build!(ctx);
}

const big = Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join("\n");

describe("contextFiles: the plugin", () => {
  it("keeps conversations, acts as no one, tells the model about its files always and how to read them in a skill", () => {
    const plugin = contextFiles();
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("context-files");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.needs).toEqual(["conversationStore"]);
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.systemPromptFragment).toContain("read_context_file");
    expect(plugin.skills?.map((s) => s.name)).toEqual(["context-files"]);
    expect(plugin.skills?.[0]?.body).toContain("search_context_files");
    expect(contextFiles({ reopen: false }).needs).toEqual([]);
  });

  it("refuses options that can't be, at once, naming them", () => {
    const refused: Array<[Parameters<typeof contextFiles>[0], string]> = [
      [{ maxChars: 0 }, "contextFiles: maxChars must be a whole number above 0"],
      [{ maxChars: 1.5 }, "contextFiles: maxChars must be a whole number above 0"],
      [{ keepRecent: 0 }, "contextFiles: keepRecent must be a whole number above 0"],
      [{ outputs: { overChars: -1 } }, "contextFiles: outputs.overChars must be a whole number above 0"],
      [{ index: { maxEntries: 0 } }, "contextFiles: index.maxEntries must be a whole number above 0"],
      [{ reopen: { maxChars: -1 } }, "contextFiles: reopen.maxChars must be a whole number from 0 up"],
      [{ overflow: "drop" as never }, 'contextFiles: overflow must be "files", "summarize" or "truncate"'],
      [{ cleanup: { afterDays: 0 } }, "contextFiles: cleanup.afterDays must be a whole number above 0"],
      [{ cleanup: { afterDays: 1.5 } }, "contextFiles: cleanup.afterDays must be a whole number above 0"],
    ];
    for (const [options, error] of refused) expect(() => contextFiles(options)).toThrow(error);
  });

  it("can't build without a data folder: the core leaves it out, saying why", async () => {
    await expect(built(contextFiles(), ctxWith({ noDataDir: true }).ctx)).rejects.toThrow("contextFiles: no data folder to keep the files in");
  });
});

describe("contextFiles: a session's conversation", () => {
  it("moves older messages to a history file past maxChars, keeping the last keepRecent exchanges", async () => {
    const owner = (await built(contextFiles({ maxChars: 30, keepRecent: 1 }))).conversation!;
    const conversation = await owner.open({ sessionKey: "c1" });
    for (const text of ["q1........", "a1........", "q2........", "a2........"]) {
      await (text.startsWith("q") ? conversation.addUserMessage(text) : conversation.addAssistantMessage(text));
    }
    expect(conversation.getMessages().map((m) => m.content)).toEqual(["q2........", "a2........"]);
    expect(await conversation.turnIndex!()).toContain('- history/1 — 2 messages, from "q1........" (2 lines)');
  });

  it("shortens as conversation-window does with overflow summarize or truncate", async () => {
    const owner = (await built(contextFiles({ maxChars: 10, overflow: "truncate" }))).conversation!;
    const conversation = await owner.open({ sessionKey: "c1" });
    await conversation.addUserMessage("12345");
    await conversation.addAssistantMessage("12345");
    expect(await conversation.addUserMessage("x")).toEqual({ messages: 2, charsBefore: 10, charsAfter: 0, durationMs: 0, outcome: "done" });
    expect(conversation.getMessages()).toEqual([{ role: "user", content: "x" }]);
  });

  it("moves tool outputs over 4000 characters by default, none with outputs: false; layers only with layers: true", async () => {
    const conversation = await (await built(contextFiles())).conversation!.open({ sessionKey: "c1" });
    expect(await conversation.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, "x".repeat(4000))).toBe("x".repeat(4000));
    expect(await conversation.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, "x".repeat(4001))).toMatchObject({ file: "outputs/1" });
    expect(conversation.placeLayers).toBeUndefined();
    const none = await (await built(contextFiles({ outputs: false, layers: true }))).conversation!.open({ sessionKey: "c2" });
    expect(none.toolOutput).toBeUndefined();
    expect(none.placeLayers).toBeDefined();
  });

  it("brings a reopened conversation back from the archive", async () => {
    const store = {
      messages: async () => ({
        messages: [
          { id: "m2", userId: "static:alice", sessionKey: "c1", role: "assistant", content: "verde", timestamp: "2026-11-13T10:01:00.000Z" },
          { id: "m1", userId: "static:alice", sessionKey: "c1", role: "user", content: "colore?", timestamp: "2026-11-13T10:00:00.000Z" },
        ] as StoredMessage[],
      }),
    } as unknown as ConversationStore;
    const owner = (await built(contextFiles(), ctxWith({ store }).ctx)).conversation!;
    const conversation = await owner.open({ sessionKey: "c1", person: { key: "static:alice" }, reopen: {}, timeZone: "UTC" });
    expect(conversation.getMessages().map((m) => m.content)).toEqual(["[Friday 2026-11-13 10:00 UTC]\ncolore?", "verde"]);
    expect(conversation.getCapturable!()).toEqual([]);
  });

  // A conversation reopened after its session closed (the next day, on the
  // same id) finds its files again: they go only when unused for days.
  it("keeps the session's files when the session closes: the conversation reopened finds them", async () => {
    const owner = (await built(contextFiles())).conversation!;
    const conversation = await owner.open({ sessionKey: "c1", person: { key: "static:alice" } });
    await conversation.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, big.repeat(20));
    owner.close!("c1");
    expect(existsSync(sessionFolder(dataDir, "c1"))).toBe(true);
    const reopened = await owner.open({ sessionKey: "c1", person: { key: "static:alice" } });
    expect(await reopened.turnIndex!()).toContain("- outputs/1 — fetch {}");
  });

  // A conversation nobody vouched for (the terminal) is never reopened: its
  // files went to the next REPL session on the same key, listed as its own.
  it("starts a conversation nobody vouched for without files, while a person's reopened conversation finds them", async () => {
    const owner = (await built(contextFiles({ outputs: { overChars: 100 } }))).conversation!;
    const terminal = await owner.open({ sessionKey: "terminal" });
    await terminal.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, big);
    owner.close!("terminal");
    expect(await (await owner.open({ sessionKey: "terminal" })).turnIndex!()).toBeUndefined();

    const alice = await owner.open({ sessionKey: "c1", person: { key: "static:alice" } });
    await alice.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, big);
    owner.close!("c1");
    expect(await (await owner.open({ sessionKey: "c1", person: { key: "static:alice" } })).turnIndex!()).toContain("outputs/1");
  });

  it("removes the files of sessions unused for cleanup.afterDays (7) before it starts taking turns, and every day at 04:00", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const seed = (await built(contextFiles())).conversation!;
    for (const key of ["old", "fresh"]) {
      const c = await seed.open({ sessionKey: key });
      await c.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, big.repeat(20));
    }
    const age = (key: string, days: number) => {
      const when = new Date(Date.now() - days * DAY);
      utimesSync(join(sessionFolder(dataDir, key), "index.json"), when, when);
    };
    age("old", 8);
    age("fresh", 3);
    const daily: unknown[] = [];
    const { ctx, logs } = ctxWith({ daily });
    await built(contextFiles(), ctx);
    expect(existsSync(sessionFolder(dataDir, "old"))).toBe(false);
    expect(existsSync(sessionFolder(dataDir, "fresh"))).toBe(true);
    expect(logs).toEqual(["[context-files] removed the files of 1 session unused for 7 days"]);
    expect(daily.map((d) => (d as unknown[]).slice(0, 2))).toEqual([["cleanup", { at: "04:00" }]]);

    age("fresh", 3);
    await built(contextFiles({ cleanup: { afterDays: 2 } }), ctxWith().ctx);
    expect(existsSync(sessionFolder(dataDir, "fresh"))).toBe(false);
  });
});

describe("contextFiles: the turn's tools", () => {
  it("reads and searches the files the session's conversation wrote, with recall_tool_calls when there's a tool log", async () => {
    const toolLog: ToolLog = { read: () => [] };
    const contributions = await built(contextFiles({ outputs: { overChars: 100 } }), ctxWith({ toolLog }).ctx);
    const conversation = await contributions.conversation!.open({ sessionKey: "c1", person: { key: "static:alice" } });
    await conversation.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, big);
    const tools = await contributions.sessionTools!({ sessionKey: "c1", person: { key: "static:alice" } } as never);
    expect(Object.keys(tools).sort()).toEqual(["read_context_file", "recall_tool_calls", "search_context_files"]);
    expect(await tools.read_context_file!.execute!({ ref: "outputs/1", from: 299 }, {} as never)).toMatchObject({ ok: true, text: "299: row 299\n300: row 300" });
    expect(await tools.search_context_files!.execute!({ text: "row 150" }, {} as never)).toEqual({ ok: true, matches: ["outputs/1:150: row 150"], truncated: false });
  });

  it("reads the files of the turn's own session only", async () => {
    const contributions = await built(contextFiles({ outputs: { overChars: 100 } }));
    const conversation = await contributions.conversation!.open({ sessionKey: "c1" });
    await conversation.toolOutput!({ toolName: "fetch", toolCallId: "t", input: {} }, big);
    const other = await contributions.sessionTools!({ sessionKey: "c2", person: null } as never);
    expect(Object.keys(other).sort()).toEqual(["read_context_file", "search_context_files"]);
    expect(await other.read_context_file!.execute!({ ref: "outputs/1" }, {} as never)).toEqual({ ok: false, error: "outputs/1 is no longer available" });
  });

  it("says what it's doing while a tool runs", async () => {
    const contributions = await built(contextFiles());
    expect(contributions.toolStatusDescribers!.read_context_file!({}, (key) => key)).toBe("context-files.status.read");
    expect(contributions.toolStatusDescribers!.search_context_files!({}, (key) => key)).toBe("context-files.status.search");
    expect(contextFiles().messages).toEqual({
      "context-files.status.read": "Reading back what I saved…",
      "context-files.status.search": "Looking through what I saved…",
      "context-files.status.recall": "Checking my memory…",
    });
  });
});
