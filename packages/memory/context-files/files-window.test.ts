import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesWindow } from "./files-window.ts";
import { openSessionFiles, type SessionFiles } from "./session-files.ts";

let root: string;
let files: SessionFiles;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "context-files-"));
  files = await openSessionFiles(root, "s1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Adds `n` exchanges of `size`-character messages, numbered from `from`. */
async function exchanges(w: ReturnType<typeof createFilesWindow>, n: number, size = 10, from = 1) {
  const reports = [];
  for (let i = from; i < from + n; i++) {
    reports.push(await w.addUserMessage(`q${i}`.padEnd(size, ".")));
    reports.push(await w.addAssistantMessage(`a${i}`.padEnd(size, ".")));
  }
  return reports;
}

describe("createFilesWindow", () => {
  it("keeps every message while they fit", async () => {
    const w = createFilesWindow({ files, maxChars: 1000, keepRecent: 1 });
    expect((await exchanges(w, 3)).every((r) => r === undefined)).toBe(true);
    expect(w.getMessages().map((m) => m.content.slice(0, 2))).toEqual(["q1", "a1", "q2", "a2", "q3", "a3"]);
    expect(files.entries()).toEqual([]);
  });

  it("past maxChars, moves what came before the last keepRecent exchanges to a history file, and reports it", async () => {
    let clock = 0;
    const w = createFilesWindow({ files, maxChars: 50, keepRecent: 2, now: () => (clock += 5) });
    await exchanges(w, 2);
    const report = await w.addUserMessage("q3".padEnd(10, "."));
    // q1 a1 q2 a2 q3 = 50 characters: still fits.
    expect(report).toBeUndefined();
    const moved = await w.addAssistantMessage("a3".padEnd(10, "."));
    expect(w.getMessages().map((m) => m.content.slice(0, 2))).toEqual(["q2", "a2", "q3", "a3"]);
    expect(moved).toEqual({ messages: 2, charsBefore: 20, charsAfter: 0, durationMs: 5, outcome: "done" });
    expect(files.entries()).toEqual([{ ref: "history/1", label: 'messages 1–2, from "q1........"', lines: 2, chars: 40 }]);
    expect(await files.read("history/1")).toMatchObject({ text: "1: [user] q1........\n2: [assistant] a1........" });
  });

  it("numbers the moved messages from the conversation's start across files", async () => {
    const w = createFilesWindow({ files, maxChars: 40, keepRecent: 1 });
    await exchanges(w, 6);
    expect(files.entries().map((e) => e.label)).toEqual([
      'messages 1–4, from "q1........"',
      'messages 5–8, from "q3........"',
    ]);
    expect(w.getMessages().map((m) => m.content.slice(0, 2))).toEqual(["q5", "a5", "q6", "a6"]);
  });

  it("never moves the last keepRecent exchanges, even past maxChars", async () => {
    const w = createFilesWindow({ files, maxChars: 10, keepRecent: 2 });
    await exchanges(w, 2, 50);
    expect(w.getMessages()).toHaveLength(4);
    expect(files.entries()).toEqual([]);
  });

  it("writes a past answer's calls on their own lines, under it", async () => {
    const w = createFilesWindow({ files, maxChars: 30, keepRecent: 1 });
    await w.addUserMessage("search", "CTX");
    await w.addAssistantMessage("found one", [{ toolName: "jira_search", input: { jql: "x" }, result: { ok: true, ran: "jira search", results: 1 } }]);
    await exchanges(w, 1, 20, 2);
    expect(await files.read("history/1")).toMatchObject({
      text: '1: [user] search\n2: [assistant] found one\n3: [call] jira_search {"jql":"x"} → {"ok":true,"ran":"jira search","results":1}',
    });
  });

  it("keeps the messages and reports the failure when the file can't be written: the next message tries again", async () => {
    const failing: SessionFiles = { ...files, write: async () => Promise.reject(new Error("disk full")) };
    const w = createFilesWindow({ files: failing, maxChars: 30, keepRecent: 1, now: () => 0 });
    const reports = await exchanges(w, 3);
    expect(w.getMessages()).toHaveLength(6);
    expect(reports.filter((r) => r !== undefined)).toEqual([
      { messages: 2, charsBefore: 20, durationMs: 0, outcome: "failed", error: "disk full" },
      { messages: 4, charsBefore: 40, durationMs: 0, outcome: "failed", error: "disk full" },
      { messages: 4, charsBefore: 40, durationMs: 0, outcome: "failed", error: "disk full" },
    ]);
  });

  it("opens with a reopened conversation's summary and messages, which aren't capturable; what's added is", async () => {
    const w = createFilesWindow({
      files,
      maxChars: 1000,
      keepRecent: 1,
      resumed: { summary: "they talked about docker", messages: [{ role: "user", content: "old q" }, { role: "assistant", content: "old a" }] },
    });
    await w.addUserMessage("new q");
    expect(w.getMessages()).toEqual([
      { role: "assistant", content: "Earlier conversation summary: they talked about docker" },
      { role: "user", content: "old q" },
      { role: "assistant", content: "old a" },
      { role: "user", content: "new q" },
    ]);
    expect(w.getCapturable()).toEqual([{ role: "user", content: "new q" }]);
  });

  it("keeps a moved message out of what's capturable, and replaces the last answer", async () => {
    const w = createFilesWindow({ files, maxChars: 30, keepRecent: 1 });
    await exchanges(w, 2);
    w.replaceLastAssistantMessage("fixed");
    expect(w.getCapturable().map((m) => m.content)).toEqual(["q2........", "fixed"]);
    expect(w.getCharCount()).toBe(15);
  });
});
