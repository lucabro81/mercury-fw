import { describe, expect, test } from "bun:test";
import type { LinkStore } from "./links.ts";
import { runLinksCli } from "./links-cli.ts";

function harness(initial: Record<string, { id: string; provider: string }> = {}) {
  const map = new Map(Object.entries(initial));
  const store: LinkStore = {
    ownerOf: (identity) => map.get(identity) as never,
    link: (identity, owner) => void map.set(identity, { id: owner.id, provider: owner.provider }),
    unlink: (identity) => map.delete(identity),
    list: () => [...map].map(([identity, owner]) => ({ identity, owner: owner as never, linkedAt: "2026-10-09T10:00:00.000Z" })),
  };
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) => runLinksCli(argv, { store, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { map, run, out, err };
}

describe("mfw identity", () => {
  test("links lists each link, or says there are none", () => {
    const empty = harness();
    expect(empty.run("links")).toBe(0);
    expect(empty.out).toEqual(["No accounts are linked."]);
    const one = harness({ "google-chat:users/1": { id: "alice", provider: "static" } });
    expect(one.run("links")).toBe(0);
    expect(one.out).toEqual(["google-chat:users/1 -> static:alice (since 2026-10-09T10:00:00.000Z)"]);
  });

  test("link links an identity to an owner, the id keeping its own colons and slashes", () => {
    const h = harness();
    expect(h.run("link", "google-chat:users/1", "oidc:3123:x")).toBe(0);
    expect(h.map.get("google-chat:users/1")).toEqual({ id: "3123:x", provider: "oidc" });
    expect(h.out).toEqual([
      "Linked google-chat:users/1 to oidc:3123:x. The running service applies it within five minutes (at once for an identity it hasn't seen yet).",
    ]);
  });

  test("link refuses what linking by code refuses: the terminal, an account to itself, a chain", () => {
    const h = harness({ "google-chat:users/1": { id: "alice", provider: "static" } });
    expect(h.run("link", "none:terminal", "static:alice")).toBe(1);
    expect(h.run("link", "static:bob", "none:terminal")).toBe(1);
    expect(h.run("link", "static:bob", "static:bob")).toBe(1);
    expect(h.run("link", "static:bob", "google-chat:users/1")).toBe(1);
    expect(h.err).toEqual([
      "The terminal is never linked.",
      "The terminal is never linked.",
      "An account can't be linked to itself.",
      "google-chat:users/1 is itself linked to static:alice: link static:bob to static:alice instead.",
    ]);
    expect([...h.map.keys()]).toEqual(["google-chat:users/1"]);
  });

  test("link refuses an identity that isn't <provider>:<id>", () => {
    const h = harness();
    expect(h.run("link", "alice", "static:bob")).toBe(1);
    expect(h.run("link", "static:bob", "static:")).toBe(1);
    expect(h.err).toEqual(['"alice" isn\'t an identity: write it as <provider>:<id>, e.g. static:alice', '"static:" isn\'t an identity: write it as <provider>:<id>, e.g. static:alice']);
  });

  test("unlink removes a link, and says when there was none", () => {
    const h = harness({ "google-chat:users/1": { id: "alice", provider: "static" } });
    expect(h.run("unlink", "google-chat:users/1")).toBe(0);
    expect(h.map.size).toBe(0);
    expect(h.run("unlink", "google-chat:users/1")).toBe(1);
    expect(h.err).toEqual(["google-chat:users/1 isn't linked."]);
  });

  test("anything else prints the usage", () => {
    const h = harness();
    expect(h.run()).toBe(1);
    expect(h.run("link", "static:a")).toBe(1);
    expect(h.err[0]).toContain("Usage: mfw identity");
  });
});
