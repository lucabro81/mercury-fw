import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonalLists } from "./personal-lists.ts";

const dir = () => mkdtempSync(join(tmpdir(), "web-search-lists-"));

describe("createPersonalLists", () => {
  it("is empty for someone who never allowed a host", async () => {
    expect(await createPersonalLists(dir()).hostsOf("people:alice")).toEqual([]);
  });

  it("keeps what a person allowed, once each, across instances (a restart)", async () => {
    const d = dir();
    const lists = createPersonalLists(d);
    await lists.add("people:alice", "docs.bun.sh");
    await lists.add("people:alice", "docs.bun.sh");
    await lists.add("people:alice", "peps.python.org");

    expect(await createPersonalLists(d).hostsOf("people:alice")).toEqual(["docs.bun.sh", "peps.python.org"]);
  });

  it("keeps people apart, whatever characters their keys hold", async () => {
    const d = dir();
    const lists = createPersonalLists(d);
    await lists.add("google-chat:users/42", "bun.sh");
    await lists.add("people:bob", "python.org");

    expect(await lists.hostsOf("google-chat:users/42")).toEqual(["bun.sh"]);
    expect(await lists.hostsOf("people:bob")).toEqual(["python.org"]);
    // one flat folder: a "/" in a key never makes a subfolder
    expect(readdirSync(join(d, "allowlist")).sort()).toEqual(["google-chat%3Ausers%2F42.json", "people%3Abob.json"]);
  });

  it("two hosts added at once by the same person are both kept", async () => {
    const lists = createPersonalLists(dir());
    await Promise.all([lists.add("people:alice", "a.test"), lists.add("people:alice", "b.test"), lists.add("people:alice", "c.test")]);
    expect((await lists.hostsOf("people:alice")).sort()).toEqual(["a.test", "b.test", "c.test"]);
  });

  // Cold review of #194: any read error counted as an empty list, so a file
  // that couldn't be read for a moment was overwritten with one host.
  it("adding to a list that can't be read fails, leaving the file as it was", async () => {
    const d = dir();
    const lists = createPersonalLists(d);
    await lists.add("people:alice", "a.test");
    const file = join(d, "allowlist", "people%3Aalice.json");
    chmodSync(file, 0o000);
    try {
      await expect(lists.add("people:alice", "b.test")).rejects.toThrow();
    } finally {
      chmodSync(file, 0o644);
    }
    expect(await lists.hostsOf("people:alice")).toEqual(["a.test"]);
  });

  it("leaves no temporary file behind", async () => {
    const d = dir();
    await createPersonalLists(d).add("people:alice", "bun.sh");
    expect(readdirSync(join(d, "allowlist"))).toEqual(["people%3Aalice.json"]);
  });

  it("reads a damaged file as an empty list, and the next host replaces it", async () => {
    const d = dir();
    mkdirSync(join(d, "allowlist"));
    writeFileSync(join(d, "allowlist", "people%3Aalice.json"), "{not json");
    const lists = createPersonalLists(d);

    expect(await lists.hostsOf("people:alice")).toEqual([]);
    await lists.add("people:alice", "bun.sh");
    expect(await lists.hostsOf("people:alice")).toEqual(["bun.sh"]);
    // Cold review of #194: the damaged file was lost; it's set aside instead.
    const aside = readdirSync(join(d, "allowlist")).filter((f) => f.startsWith("people%3Aalice.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(d, "allowlist", aside[0]!), "utf8")).toBe("{not json");
  });

  it("sets aside a file that is JSON but not a list of hosts, before writing", async () => {
    const d = dir();
    mkdirSync(join(d, "allowlist"));
    writeFileSync(join(d, "allowlist", "people%3Aalice.json"), JSON.stringify({ sites: ["a.test"] }));
    const lists = createPersonalLists(d);

    await lists.add("people:alice", "bun.sh");

    expect(await lists.hostsOf("people:alice")).toEqual(["bun.sh"]);
    const aside = readdirSync(join(d, "allowlist")).filter((f) => f.startsWith("people%3Aalice.json.corrupt-"));
    expect(aside).toHaveLength(1);
  });

  it("sets aside a file whose entries aren't all hosts any more, before writing", async () => {
    const d = dir();
    mkdirSync(join(d, "allowlist"));
    const original = JSON.stringify({ hosts: ["bun.sh", "com"] });
    writeFileSync(join(d, "allowlist", "people%3Aalice.json"), original);

    await createPersonalLists(d).add("people:alice", "python.org");

    const aside = readdirSync(join(d, "allowlist")).filter((f) => f.startsWith("people%3Aalice.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(d, "allowlist", aside[0]!), "utf8")).toBe(original);
    expect(await createPersonalLists(d).hostsOf("people:alice")).toEqual(["bun.sh", "python.org"]);
  });

  it("keeps only well-formed host names read back from a file", async () => {
    const d = dir();
    mkdirSync(join(d, "allowlist"));
    writeFileSync(join(d, "allowlist", "people%3Aalice.json"), JSON.stringify({ hosts: ["bun.sh", 7, "com", "Not A Host"] }));

    expect(await createPersonalLists(d).hostsOf("people:alice")).toEqual(["bun.sh"]);
  });
});
