import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindow } from "@mercury-fw/conversation-window";
import { createFilesConversation, OUTPUT_NOTE, PAST_CALL_NOTE } from "./conversation.ts";
import { openSessionFiles, type SessionFiles } from "./session-files.ts";

let root: string;
let files: SessionFiles;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "context-files-"));
  files = await openSessionFiles(root, "s1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const window = () => createWindow({ summarize: async () => "summary", maxChars: 10_000 });
const big = { issues: Array.from({ length: 60 }, (_, i) => ({ key: `X-${i + 1}`, summary: `Issue number ${i + 1}` })) };
const bigText = JSON.stringify(big, null, 2);

describe("createFilesConversation: the messages", () => {
  it("keeps the messages as the window does", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 30 } });
    await conversation.addUserMessage("hi", "CTX");
    await conversation.addAssistantMessage("hello");
    expect(conversation.getMessages()).toEqual([
      { role: "user", content: "hi", context: "CTX" },
      { role: "assistant", content: "hello" },
    ]);
    expect(conversation.getCapturable?.()).toEqual(conversation.getMessages());
    expect(conversation.getCharCount()).toBe(2 + 3 + 5);
  });
});

describe("createFilesConversation: tool outputs", () => {
  const call = { toolName: "jira_search", toolCallId: "c1", input: { jql: "project = X" } };

  it("moves an output over overChars to a file, and gives the model the file, its size and its head", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 30 } });
    const viewed = await conversation.toolOutput!(call, big);
    const lines = bigText.split("\n");
    expect(viewed).toEqual({
      file: "outputs/1",
      lines: lines.length,
      chars: bigText.length,
      head: lines.slice(0, 20).join("\n"),
      note: OUTPUT_NOTE("outputs/1"),
    });
    expect(await files.read("outputs/1", 1, 3)).toMatchObject({ text: `1: {\n2:   "issues": [\n3:     {` });
    expect(files.entries()).toEqual([{ ref: "outputs/1", label: 'jira_search {"jql":"project = X"}', lines: lines.length, chars: bigText.length }]);
  });

  it("writes a text output as it is", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 10 }, index: { maxEntries: 30 } });
    await conversation.toolOutput!(call, "line one\nline two\nline three");
    expect(await files.read("outputs/1")).toMatchObject({ text: "1: line one\n2: line two\n3: line three" });
  });

  it("cuts a head of long lines at 1000 characters", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 10 }, index: { maxEntries: 30 } });
    const viewed = (await conversation.toolOutput!(call, "x".repeat(5000))) as { head: string };
    expect(viewed.head).toBe(`${"x".repeat(1000)}…`);
  });

  it("leaves an output up to overChars, one of its own tools, and every output with outputs: false, as it is", async () => {
    const small = { ok: "short" };
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: bigText.length }, index: { maxEntries: 30 } });
    expect(await conversation.toolOutput!(call, big)).toBe(big);
    expect(await conversation.toolOutput!(call, small)).toBe(small);
    const tight = createFilesConversation({ files, window: window(), outputs: { overChars: 10 }, index: { maxEntries: 30 } });
    for (const toolName of ["read_context_file", "search_context_files"]) {
      expect(await tight.toolOutput!({ ...call, toolName }, big)).toBe(big);
    }
    expect(createFilesConversation({ files, window: window(), outputs: false, index: { maxEntries: 30 } }).toolOutput).toBeUndefined();
    expect(files.entries()).toEqual([]);
  });

  it("cuts a long input in the file's label", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 10 }, index: { maxEntries: 30 } });
    await conversation.toolOutput!({ ...call, input: { url: `https://example.org/${"a".repeat(200)}` } }, bigText);
    expect(files.entries()[0]!.label).toBe(`jira_search ${JSON.stringify({ url: `https://example.org/${"a".repeat(200)}` }).slice(0, 80)}…`);
  });
});

describe("createFilesConversation: past calls", () => {
  const shown = { ok: true, ran: "jira search", results: 60, note: "Data not kept." };

  it("points a past call whose output went to a file at it, over what the core shows", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 30 } });
    await conversation.toolOutput!({ toolName: "jira_search", toolCallId: "c1", input: { jql: "project = X" } }, big);
    expect(conversation.pastCall!({ toolName: "jira_search", input: { jql: "project = X" }, result: { ok: true, ran: "x" } }, shown)).toEqual({
      ...shown,
      file: "outputs/1",
      note: PAST_CALL_NOTE("outputs/1"),
    });
  });

  // The core keeps a call's input with every string cut at 500 characters: the
  // call must still be found from what the core kept.
  it("finds the file of a call whose input the core kept cut", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 30 } });
    const long = "q".repeat(800);
    await conversation.toolOutput!({ toolName: "web_fetch", toolCallId: "c1", input: { url: long } }, big);
    const kept = { url: `${long.slice(0, 500)}…` };
    expect(conversation.pastCall!({ toolName: "web_fetch", input: kept, result: { ok: true, ran: "x" } }, shown)).toMatchObject({ file: "outputs/1" });
  });

  it("shows what the core shows of a past call with no file", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 30 } });
    expect(conversation.pastCall!({ toolName: "jira_search", input: {}, result: { ok: true, ran: "x" } }, shown)).toBe(shown);
  });
});

describe("createFilesConversation: the index in front of each message", () => {
  it("says nothing while there are no files", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 30 } });
    expect(await conversation.turnIndex!()).toBeUndefined();
  });

  it("lists every file with its label and size", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 30 } });
    await conversation.toolOutput!({ toolName: "jira_search", toolCallId: "c1", input: { jql: "project = X" } }, big);
    await files.write("history", "a\nb", "messages 1–4");
    expect(await conversation.turnIndex!()).toBe(
      [
        "<context-files>",
        "Files of this conversation (open them with read_context_file, search them with search_context_files):",
        `- outputs/1 — jira_search {"jql":"project = X"} (${bigText.split("\n").length} lines)`,
        "- history/1 — messages 1–4 (2 lines)",
        "</context-files>",
      ].join("\n"),
    );
  });

  it("folds the oldest files past maxEntries into one line pointing at the search", async () => {
    const conversation = createFilesConversation({ files, window: window(), outputs: { overChars: 100 }, index: { maxEntries: 2 } });
    for (const n of [1, 2, 3, 4]) await files.write("outputs", "x", `tool ${n}`);
    expect(await conversation.turnIndex!()).toBe(
      [
        "<context-files>",
        "Files of this conversation (open them with read_context_file, search them with search_context_files):",
        "- 2 earlier files: find them with search_context_files",
        "- outputs/3 — tool 3 (1 line)",
        "- outputs/4 — tool 4 (1 line)",
        "</context-files>",
      ].join("\n"),
    );
  });
});
