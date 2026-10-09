import { describe, expect, test } from "bun:test";
import type { Directory, DirectoryPerson, Principal } from "@mercury-fw/channel-types";
import { createPeople, OPERATOR_PRINCIPAL, UNAVAILABLE_MESSAGE, UNKNOWN_MESSAGE } from "./people.ts";
import type { LinkStore } from "./links.ts";

const alice: Principal = { id: "alice", provider: "static", displayName: "Alice" };
const terminal = OPERATOR_PRINCIPAL;

/** A directory answering from `people` (keyed by the principal's user key), counting its lookups. */
function directoryOf(people: Record<string, DirectoryPerson>, fail = false) {
  const calls: string[] = [];
  const directory: Directory = {
    resolve: async (p) => {
      calls.push(`${p.provider}:${p.id}`);
      if (fail) throw new Error("directory down");
      return people[`${p.provider}:${p.id}`] ?? null;
    },
  };
  return { directory, calls };
}

const aliceInDirectory: DirectoryPerson = { id: "alice", displayName: "Alice A.", email: "alice@example.com", roles: ["mercury.act-as-self"] };

describe("identify without a directory", () => {
  test("the person is whoever the channel says, keyed on the user key, with no roles", async () => {
    const people = createPeople({ directory: "none" });
    expect(await people.identify(alice)).toEqual({
      ok: true,
      operator: false,
      person: { key: "static:alice", displayName: "Alice", roles: [] },
    });
  });

  test("the terminal is the operator", async () => {
    const people = createPeople({ directory: "none" });
    expect(await people.identify(terminal)).toEqual({ ok: true, operator: true, person: { key: "none:terminal", roles: [] } });
  });
});

// The operator gets every plugin as Mercury and skips the directory: only the
// core's own terminal can be it, never a principal a channel or an auth
// provider built, whatever it claims.
describe("the operator can't be forged", () => {
  for (const directory of ["none", "failed"] as const) {
    test(`a principal claiming "none" that isn't the terminal's is refused (directory: ${directory})`, async () => {
      const logs: string[] = [];
      const people = createPeople({ directory, unknown: "allow", log: (m) => logs.push(m) });
      expect(await people.identify({ id: "terminal", provider: "none" })).toEqual({ ok: false, reason: "unknown", message: UNKNOWN_MESSAGE });
      expect(logs).toEqual(['[identity] refused a principal claiming to be nobody\'s ("none:terminal"): only the terminal is the operator']);
    });
  }
});

describe("identify with a directory", () => {
  test("a known person is keyed on the directory's name and id, with the directory's roles", async () => {
    const { directory } = directoryOf({ "static:alice": aliceInDirectory });
    const people = createPeople({ directory: { name: "people", directory } });
    expect(await people.identify(alice)).toEqual({
      ok: true,
      operator: false,
      person: { key: "people:alice", displayName: "Alice A.", email: "alice@example.com", roles: ["mercury.act-as-self"] },
    });
  });

  test("someone it doesn't know is refused by default, with the default message", async () => {
    const { directory } = directoryOf({});
    const people = createPeople({ directory: { name: "people", directory } });
    expect(await people.identify(alice)).toEqual({ ok: false, reason: "unknown", message: UNKNOWN_MESSAGE });
  });

  test("an instance can say its own refusal", async () => {
    const { directory } = directoryOf({});
    const people = createPeople({ directory: { name: "people", directory }, unknownMessage: "Ask Mario." });
    expect(await people.identify(alice)).toMatchObject({ ok: false, message: "Ask Mario." });
  });

  test("an open instance talks to someone it doesn't know, as the channel says, with no roles", async () => {
    const { directory } = directoryOf({});
    const people = createPeople({ directory: { name: "people", directory }, unknown: "allow" });
    expect(await people.identify(alice)).toEqual({
      ok: true,
      operator: false,
      person: { key: "static:alice", displayName: "Alice", roles: [] },
    });
  });

  // Identity is a security check: when the directory can't answer, nobody
  // gets in, open instance or not.
  test("a directory that fails refuses, even on an open instance, and says so", async () => {
    const logs: string[] = [];
    const { directory } = directoryOf({}, true);
    const people = createPeople({ directory: { name: "people", directory }, unknown: "allow", log: (m) => logs.push(m) });
    expect(await people.identify(alice)).toEqual({ ok: false, reason: "unavailable", message: UNAVAILABLE_MESSAGE });
    expect(logs.join("\n")).toContain("directory down");
  });

  test("a declared directory that failed to load refuses everyone but the terminal", async () => {
    const people = createPeople({ directory: "failed", unknown: "allow" });
    expect(await people.identify(alice)).toEqual({ ok: false, reason: "unavailable", message: UNAVAILABLE_MESSAGE });
    expect(await people.identify(terminal)).toMatchObject({ ok: true, operator: true });
  });

  test("the terminal never reaches the directory", async () => {
    const { directory, calls } = directoryOf({});
    const people = createPeople({ directory: { name: "people", directory } });
    expect(await people.identify(terminal)).toMatchObject({ ok: true, operator: true });
    expect(calls).toEqual([]);
  });
});

describe("caching", () => {
  test("an answer is reused until it expires, so a revoked role stops counting within the ttl", async () => {
    let now = 0;
    const roles = { current: ["mercury.act-as-self"] };
    const calls: number[] = [];
    const directory: Directory = {
      resolve: async () => {
        calls.push(now);
        return { id: "alice", roles: roles.current };
      },
    };
    const people = createPeople({ directory: { name: "people", directory }, ttlMs: 1000, now: () => now });

    await people.identify(alice);
    roles.current = [];
    now = 999;
    expect(await people.identify(alice)).toMatchObject({ person: { roles: ["mercury.act-as-self"] } });
    now = 1000;
    expect(await people.identify(alice)).toMatchObject({ person: { roles: [] } });
    expect(calls).toEqual([0, 1000]);
  });

  test("expired answers are swept once the cache grows, so visitors don't pile up", async () => {
    let now = 0;
    const calls: string[] = [];
    const directory: Directory = {
      resolve: async (p) => {
        calls.push(p.id);
        return null;
      },
    };
    const people = createPeople({ directory: { name: "people", directory }, unknown: "allow", ttlMs: 10, now: () => now });
    for (let i = 0; i < 1000; i++) await people.identify({ id: `v${i}`, provider: "static" });
    now = 10;
    await people.identify({ id: "late", provider: "static" });
    // The early visitors' answers were swept: asking again goes back to the directory.
    now = 11;
    calls.length = 0;
    await people.identify({ id: "v0", provider: "static" });
    await people.identify({ id: "late", provider: "static" });
    expect(calls).toEqual(["v0"]);
  });

  test("an unknown answer is cached too", async () => {
    const { directory, calls } = directoryOf({});
    const people = createPeople({ directory: { name: "people", directory } });
    await people.identify(alice);
    await people.identify(alice);
    expect(calls).toEqual(["static:alice"]);
  });

  test("a failure isn't cached: the next turn asks again", async () => {
    let fail = true;
    const directory: Directory = {
      resolve: async () => {
        if (fail) throw new Error("down");
        return aliceInDirectory;
      },
    };
    const people = createPeople({ directory: { name: "people", directory }, log: () => {} });
    expect(await people.identify(alice)).toMatchObject({ ok: false, reason: "unavailable" });
    fail = false;
    expect(await people.identify(alice)).toMatchObject({ ok: true, person: { key: "people:alice" } });
  });

  test("concurrent lookups for the same principal ask the directory once", async () => {
    const { directory, calls } = directoryOf({ "static:alice": aliceInDirectory });
    const people = createPeople({ directory: { name: "people", directory } });
    await Promise.all([people.identify(alice), people.identify(alice)]);
    expect(calls).toEqual(["static:alice"]);
  });

  test("different principals are cached apart", async () => {
    const { directory, calls } = directoryOf({ "static:alice": aliceInDirectory });
    const people = createPeople({ directory: { name: "people", directory } });
    await people.identify(alice);
    expect(await people.identify({ id: "bob", provider: "static" })).toMatchObject({ ok: false, reason: "unknown" });
    expect(calls).toEqual(["static:alice", "static:bob"]);
  });
});

describe("admit", () => {
  test("is the identification without the person", async () => {
    const { directory } = directoryOf({ "static:alice": aliceInDirectory });
    const people = createPeople({ directory: { name: "people", directory } });
    expect(await people.admit(alice)).toEqual({ ok: true });
    expect(await people.admit({ id: "bob", provider: "static" })).toEqual({ ok: false, reason: "unknown", message: UNKNOWN_MESSAGE });
  });
});

/** A link store over a fixed map from identity to owner. */
function linksOf(map: Record<string, { id: string; provider: Principal["provider"] }>): LinkStore {
  return {
    ownerOf: (identity) => map[identity],
    link: (identity, owner) => void (map[identity] = { id: owner.id, provider: owner.provider }),
    owns: (identity) => Object.values(map).some((o) => `${o.provider}:${o.id}` === identity),
    unlink: (identity) => delete map[identity],
    list: () => [],
  };
}

// #190: an identity linked to another account is the person that account is.
describe("identify with account links", () => {
  const chat: Principal = { id: "users/1", provider: "google-chat", displayName: "Alice on Chat" };

  test("without a directory, a linked identity is keyed on its owner", async () => {
    const people = createPeople({ directory: "none", links: linksOf({ "google-chat:users/1": { id: "alice", provider: "static" } }) });
    expect(await people.identify(chat)).toEqual({ ok: true, operator: false, person: { key: "static:alice", roles: [] } });
  });

  test("with a directory, the owner is who the directory resolves, roles included", async () => {
    const { directory, calls } = directoryOf({ "static:alice": aliceInDirectory });
    const people = createPeople({
      directory: { name: "people", directory },
      links: linksOf({ "google-chat:users/1": { id: "alice", provider: "static" } }),
    });
    expect(await people.identify(chat)).toMatchObject({ ok: true, person: { key: "people:alice", roles: ["mercury.act-as-self"] } });
    expect(calls).toEqual(["static:alice"]);
  });

  test("an identity that isn't linked is itself", async () => {
    const people = createPeople({ directory: "none", links: linksOf({}) });
    expect(await people.identify(chat)).toMatchObject({ person: { key: "google-chat:users/1" } });
  });

  test("forget drops a cached answer, so a new link counts at once", async () => {
    const map: Record<string, { id: string; provider: Principal["provider"] }> = {};
    const { directory } = directoryOf({ "static:alice": aliceInDirectory });
    const people = createPeople({ directory: { name: "people", directory }, links: linksOf(map), unknown: "allow" });
    expect(await people.identify(chat)).toMatchObject({ person: { key: "google-chat:users/1" } });
    map["google-chat:users/1"] = { id: "alice", provider: "static" };
    expect(await people.identify(chat)).toMatchObject({ person: { key: "google-chat:users/1" } });
    people.forget(chat);
    expect(await people.identify(chat)).toMatchObject({ person: { key: "people:alice" } });
  });

  // Regression (#192 review): forget didn't reach a lookup already under
  // way, which then cached what it found before the link.
  test("forget also drops a lookup under way: what it finds isn't kept", async () => {
    const map: Record<string, { id: string; provider: Principal["provider"] }> = {};
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const directory: Directory = {
      resolve: async (p) => {
        calls.push(`${p.provider}:${p.id}`);
        if (calls.length === 1) await gate;
        return { id: p.id, roles: [] };
      },
    };
    const people = createPeople({ directory: { name: "people", directory }, links: linksOf(map) });
    const before = people.identify(chat);
    map["google-chat:users/1"] = { id: "alice", provider: "static" };
    people.forget(chat);
    release();
    await before;
    expect(await people.identify(chat)).toMatchObject({ person: { key: "people:alice" } });
    expect(calls).toEqual(["google-chat:users/1", "static:alice"]);
  });

  // The link check itself asks who an account is on its own: a link must
  // never hide that the directory knows it as someone else.
  test("identifyUnlinked ignores links and the cache", async () => {
    const { directory, calls } = directoryOf({ "google-chat:users/1": { id: "carol", roles: [] } });
    const people = createPeople({
      directory: { name: "people", directory },
      links: linksOf({ "google-chat:users/1": { id: "alice", provider: "static" } }),
    });
    expect(await people.identifyUnlinked(chat)).toMatchObject({ person: { key: "people:carol" } });
    expect(await people.identifyUnlinked(chat)).toMatchObject({ person: { key: "people:carol" } });
    expect(calls).toEqual(["google-chat:users/1", "google-chat:users/1"]);
  });
});
