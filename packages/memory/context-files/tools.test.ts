import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextFileTools } from "./tools.ts";
import { openSessionFiles, type SessionFiles } from "./session-files.ts";

let root: string;
let files: SessionFiles;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "context-files-"));
  files = await openSessionFiles(root, "s1");
  await files.write("outputs", "alpha\nbeta\ngamma", "t");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs `tool` on `input` as the AI SDK would, after checking it against the tool's schema. */
async function run(tool: { execute?: unknown; inputSchema: unknown }, input: unknown) {
  const parsed = (tool.inputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }).safeParse(input);
  if (!parsed.success) return "invalid";
  return (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(parsed.data, { toolCallId: "c", messages: [] });
}

describe("createContextFileTools", () => {
  it("read_context_file reads a file of the session, or a range of it", async () => {
    const { read_context_file } = createContextFileTools(files);
    expect(await run(read_context_file, { ref: "outputs/1" })).toEqual({ ok: true, ref: "outputs/1", from: 1, to: 3, totalLines: 3, text: "1: alpha\n2: beta\n3: gamma" });
    expect(await run(read_context_file, { ref: "outputs/1", from: 2, to: 2 })).toMatchObject({ ok: true, text: "2: beta" });
    expect(await run(read_context_file, { ref: "outputs/9" })).toEqual({ ok: false, error: "outputs/9 is no longer available" });
  });

  it("search_context_files finds a text in the session's files, or in one", async () => {
    const { search_context_files } = createContextFileTools(files);
    expect(await run(search_context_files, { text: "BETA" })).toEqual({ ok: true, matches: ["outputs/1:2: beta"], truncated: false });
    expect(await run(search_context_files, { text: "beta", ref: "history/1" })).toEqual({ ok: false, error: "history/1 is no longer available" });
  });

  it("refuses lines that aren't whole numbers from 1, and an empty text", async () => {
    const { read_context_file, search_context_files } = createContextFileTools(files);
    for (const bad of [{ ref: "outputs/1", from: 0 }, { ref: "outputs/1", to: 1.5 }, { from: 1 }]) expect(await run(read_context_file, bad)).toBe("invalid");
    expect(await run(search_context_files, { text: "" })).toBe("invalid");
  });
});
