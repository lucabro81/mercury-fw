import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
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
  });

  it("keeps only well-formed host names read back from a file", async () => {
    const d = dir();
    mkdirSync(join(d, "allowlist"));
    writeFileSync(join(d, "allowlist", "people%3Aalice.json"), JSON.stringify({ hosts: ["bun.sh", 7, "com", "Not A Host"] }));

    expect(await createPersonalLists(d).hostsOf("people:alice")).toEqual(["bun.sh"]);
  });
});
