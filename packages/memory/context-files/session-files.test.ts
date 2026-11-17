import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionFiles, sessionFolder } from "./session-files.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "context-files-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sessionFolder", () => {
  it("names a session's folder by a hash of its key: the same key, the same folder; no key reaches outside the root", () => {
    const a = sessionFolder(root, "spaces/AAA");
    expect(sessionFolder(root, "spaces/AAA")).toBe(a);
    expect(sessionFolder(root, "spaces/BBB")).not.toBe(a);
    for (const key of ["..", "../../etc", "/abs", "a/../../b"]) {
      const folder = sessionFolder(root, key);
      expect(folder.startsWith(join(root, "sessions") + "/")).toBe(true);
      expect(folder.slice(join(root, "sessions").length + 1)).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("openSessionFiles", () => {
  it("writes a text under a numbered ref of its kind and lists it with its label, lines and size", async () => {
    const files = await openSessionFiles(root, "s1");
    expect(await files.write("outputs", "one\ntwo\nthree", "jira_search — jql=project = X")).toBe("outputs/1");
    expect(await files.write("outputs", "a", "web_fetch — url=https://x")).toBe("outputs/2");
    expect(await files.write("history", "h", "messages 1–4")).toBe("history/1");
    expect(files.entries()).toEqual([
      { ref: "outputs/1", label: "jira_search — jql=project = X", lines: 3, chars: 13 },
      { ref: "outputs/2", label: "web_fetch — url=https://x", lines: 1, chars: 1 },
      { ref: "history/1", label: "messages 1–4", lines: 1, chars: 1 },
    ]);
  });

  it("finds the newest file written for a key, also after a restart, and none for a key it never got", async () => {
    const files = await openSessionFiles(root, "s1");
    await files.write("outputs", "a", "t", "jira:{}");
    await files.write("outputs", "b", "t");
    await files.write("outputs", "c", "t", "jira:{}");
    expect(files.refFor("jira:{}")).toBe("outputs/3");
    expect((await openSessionFiles(root, "s1")).refFor("jira:{}")).toBe("outputs/3");
    expect(files.refFor("web:{}")).toBeUndefined();
    expect(files.entries()[0]).toEqual({ ref: "outputs/1", label: "t", lines: 1, chars: 1 });
  });

  // Regression: two writes at once took the same number, the second file overwriting the first.
  it("gives writes made at once refs of their own, each with its text", async () => {
    const files = await openSessionFiles(root, "s1");
    const refs = await Promise.all(["a", "b", "c"].map((t) => files.write("layers", t, t)));
    expect(refs).toEqual(["layers/1", "layers/2", "layers/3"]);
    expect(await Promise.all(refs.map(async (r) => ((await files.read(r)) as { text: string }).text))).toEqual(["1: a", "1: b", "1: c"]);
    expect((await openSessionFiles(root, "s1")).entries().map((e) => e.ref)).toEqual(refs);
  });

  it("writes atomically: no temporary file is left next to what it wrote", async () => {
    const files = await openSessionFiles(root, "s1");
    await files.write("outputs", "x", "t");
    const folder = sessionFolder(root, "s1");
    expect(readdirSync(join(folder, "outputs"))).toEqual(["1.txt"]);
    expect(readdirSync(folder).sort()).toEqual(["index.json", "outputs"]);
    expect(readFileSync(join(folder, "outputs", "1.txt"), "utf8")).toBe("x");
  });

  it("reads a file's lines numbered from 1, a range of them, and says how many there are", async () => {
    const files = await openSessionFiles(root, "s1");
    await files.write("outputs", "alpha\nbeta\ngamma\ndelta", "t");
    expect(await files.read("outputs/1")).toEqual({ ok: true, ref: "outputs/1", from: 1, to: 4, totalLines: 4, text: "1: alpha\n2: beta\n3: gamma\n4: delta" });
    expect(await files.read("outputs/1", 2, 3)).toEqual({ ok: true, ref: "outputs/1", from: 2, to: 3, totalLines: 4, text: "2: beta\n3: gamma" });
    expect(await files.read("outputs/1", 3, 99)).toEqual({ ok: true, ref: "outputs/1", from: 3, to: 4, totalLines: 4, text: "3: gamma\n4: delta" });
  });

  it("refuses a range past the end of the file, or one that ends before it starts, saying how many lines there are", async () => {
    const files = await openSessionFiles(root, "s1");
    await files.write("outputs", "a\nb\nc", "t");
    expect(await files.read("outputs/1", 4)).toEqual({ ok: false, error: "outputs/1 has 3 lines: from must be 3 or less" });
    expect(await files.read("outputs/1", 3, 2)).toEqual({ ok: false, error: "outputs/1: to (2) comes before from (3)" });
  });

  it("caps a read at 200 lines, and says where to go on from", async () => {
    const files = await openSessionFiles(root, "s1");
    await files.write("outputs", Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"), "t");
    const read = await files.read("outputs/1", 10);
    expect(read).toMatchObject({ ok: true, from: 10, to: 209, totalLines: 500, next: 210 });
    expect((read as { text: string }).text.split("\n")).toHaveLength(200);
  });

  it("refuses a ref that isn't one of its shape, without touching the disk outside the session", async () => {
    const files = await openSessionFiles(root, "s1");
    for (const ref of ["../s2/outputs/1", "outputs/../../x", "/etc/passwd", "outputs/1.txt", "secrets/1", "outputs/x", "index"]) {
      expect(await files.read(ref)).toEqual({ ok: false, error: `"${ref}" isn't a file of this conversation: refs look like outputs/3, history/1 or layers/2` });
    }
  });

  it("answers a ref of its shape that isn't there as no longer available", async () => {
    const files = await openSessionFiles(root, "s1");
    expect(await files.read("outputs/7")).toEqual({ ok: false, error: "outputs/7 is no longer available" });
  });

  it("finds a text in every file, or in one, case-insensitively, as ref:line, capped at 50 matches", async () => {
    const files = await openSessionFiles(root, "s1");
    await files.write("outputs", "Docker setup\nnothing\nmore DOCKER", "t");
    await files.write("history", "user: docker?", "h");
    expect(await files.search("docker")).toEqual({
      ok: true,
      matches: ["outputs/1:1: Docker setup", "outputs/1:3: more DOCKER", "history/1:1: user: docker?"],
      truncated: false,
    });
    expect(await files.search("docker", "history/1")).toEqual({ ok: true, matches: ["history/1:1: user: docker?"], truncated: false });
    expect(await files.search("(a+)+$")).toEqual({ ok: true, matches: [], truncated: false });

    await files.write("outputs", Array.from({ length: 80 }, () => "hit").join("\n"), "t");
    const many = await files.search("hit");
    expect(many).toMatchObject({ ok: true, truncated: true });
    expect((many as { matches: string[] }).matches).toHaveLength(50);
  });

  it("refuses a search in a ref that isn't one, or isn't there", async () => {
    const files = await openSessionFiles(root, "s1");
    expect(await files.search("x", "../a")).toEqual({ ok: false, error: `"../a" isn't a file of this conversation: refs look like outputs/3, history/1 or layers/2` });
    expect(await files.search("x", "outputs/4")).toEqual({ ok: false, error: "outputs/4 is no longer available" });
  });

  it("keeps two sessions apart: one never reads the other's files", async () => {
    const a = await openSessionFiles(root, "s1");
    const b = await openSessionFiles(root, "s2");
    await a.write("outputs", "secret", "t");
    expect(await b.read("outputs/1")).toEqual({ ok: false, error: "outputs/1 is no longer available" });
    expect(await b.search("secret")).toEqual({ ok: true, matches: [], truncated: false });
  });

  it("finds a session's files again after a restart, and goes on numbering after them", async () => {
    const before = await openSessionFiles(root, "s1");
    await before.write("outputs", "kept", "t");
    const after = await openSessionFiles(root, "s1");
    expect(after.entries()).toEqual([{ ref: "outputs/1", label: "t", lines: 1, chars: 4 }]);
    expect(await after.read("outputs/1")).toMatchObject({ ok: true, text: "1: kept" });
    expect(await after.write("outputs", "new", "t2")).toBe("outputs/2");
  });

  it("starts empty when the session's index can't be read", async () => {
    const before = await openSessionFiles(root, "s1");
    await before.write("outputs", "kept", "t");
    await Bun.write(join(sessionFolder(root, "s1"), "index.json"), "{ not json");
    expect((await openSessionFiles(root, "s1")).entries()).toEqual([]);
  });

  it("removes the session's folder, and is fine when there is none", async () => {
    const files = await openSessionFiles(root, "s1");
    await files.write("outputs", "x", "t");
    await files.remove();
    expect(existsSync(sessionFolder(root, "s1"))).toBe(false);
    await (await openSessionFiles(root, "s2")).remove();
  });
});
