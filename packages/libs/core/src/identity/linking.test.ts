import { describe, expect, test } from "bun:test";
import type { Directory, DirectoryPerson, Principal } from "@mercury-fw/channel-types";
import { createPeople, OPERATOR_PRINCIPAL } from "./people.ts";
import type { LinkStore } from "./links.ts";
import { createLinking, isLinkCode } from "./linking.ts";

const alice: Principal = { id: "alice", provider: "static", displayName: "Alice" };
const chat: Principal = { id: "users/1", provider: "google-chat" };

/** An in-memory link store, recording what was linked. */
function memoryLinks(): LinkStore & { map: Map<string, { id: string; provider: Principal["provider"] }> } {
  const map = new Map<string, { id: string; provider: Principal["provider"] }>();
  return {
    map,
    ownerOf: (identity) => map.get(identity),
    link: (identity, owner) => void map.set(identity, { id: owner.id, provider: owner.provider }),
    owns: (identity) => [...map.values()].some((o) => `${o.provider}:${o.id}` === identity),
    unlink: (identity) => map.delete(identity),
    list: () => [],
  };
}

function setup(opts: { people?: Record<string, DirectoryPerson>; directory?: boolean; failing?: boolean } = {}) {
  let now = 0;
  const links = memoryLinks();
  const directory: Directory = {
    resolve: async (p) => {
      if (opts.failing) throw new Error("down");
      return opts.people?.[`${p.provider}:${p.id}`] ?? null;
    },
  };
  const people = createPeople({
    directory: opts.directory ? { name: "people", directory } : "none",
    links,
    log: () => {},
  });
  const logs: string[] = [];
  const linking = createLinking({ people, links, now: () => now, log: (m) => logs.push(m) });
  return { linking, links, people, logs, tick: (ms: number) => (now += ms) };
}

async function codeFor(linking: ReturnType<typeof createLinking>, owner: Principal): Promise<string> {
  const started = await linking.start(owner);
  if (!started.ok) throw new Error(started.error);
  return started.code;
}

describe("link codes", () => {
  test("have a shape no confirmation token has", () => {
    expect(isLinkCode("a1B2-c3D4-e5F6")).toBe(true);
    expect(isLinkCode("  a1B2-c3D4-e5F6 ")).toBe(true);
    expect(isLinkCode("k9m2-x7q4")).toBe(false);
    expect(isLinkCode("a1B2-c3D4-e5F6-g7H8")).toBe(false);
    expect(isLinkCode("link a1B2-c3D4-e5F6")).toBe(false);
  });

  test("start hands an admitted person a code that expires in ten minutes", async () => {
    const { linking } = setup();
    const started = await linking.start(alice);
    expect(started).toMatchObject({ ok: true, expiresAt: new Date(10 * 60_000).toISOString() });
    expect(isLinkCode((started as { code: string }).code)).toBe(true);
  });

  test("start refuses the operator, and someone the core doesn't admit", async () => {
    expect(await setup().linking.start(OPERATOR_PRINCIPAL)).toEqual({ ok: false, error: "The terminal can't link accounts." });
    expect(await setup({ directory: true }).linking.start(alice)).toMatchObject({ ok: false });
  });
});

describe("redeeming a code", () => {
  test("text that isn't a code is left to the turn", async () => {
    expect(await setup().linking.redeem(chat, "hello")).toBeNull();
  });

  test("the first time says whom it would link to and asks to send it again; the second time links", async () => {
    const { linking, links, people, logs } = setup();
    const code = await codeFor(linking, alice);
    expect(await linking.redeem(chat, code)).toBe(
      "This will link this account to Alice: from then on Mercury treats them as one person, with Alice's private area and roles. Send the same code again to confirm.",
    );
    expect(links.map.size).toBe(0);
    expect(await linking.redeem(chat, ` ${code} `)).toBe("Linked: this account is now Alice.");
    expect(links.map.get("google-chat:users/1")).toEqual({ id: "alice", provider: "static" });
    expect(await people.identify(chat)).toMatchObject({ person: { key: "static:alice" } });
    expect(logs).toEqual(["[identity] linked google-chat:users/1 to static:alice"]);
  });

  test("a code is single-use", async () => {
    const { linking } = setup();
    const code = await codeFor(linking, alice);
    await linking.redeem(chat, code);
    await linking.redeem(chat, code);
    expect(await linking.redeem({ id: "users/2", provider: "google-chat" }, code)).toBe(
      "That code isn't valid: it may have expired or been used already. Ask for a new one on the account you want to link to.",
    );
  });

  test("an expired or unknown code is refused, the same way", async () => {
    const { linking, tick, links } = setup();
    const code = await codeFor(linking, alice);
    await linking.redeem(chat, code);
    tick(10 * 60_000);
    expect(await linking.redeem(chat, code)).toContain("That code isn't valid");
    expect(await linking.redeem(chat, "zzzz-zzzz-zzzz")).toContain("That code isn't valid");
    expect(links.map.size).toBe(0);
  });

  // Regression (#192 review): an account that other accounts are linked to,
  // linked in turn, chained them; they'd stop being its person.
  test("an account other accounts are linked to can't be linked in turn", async () => {
    const { linking, links } = setup();
    links.link("google-chat:users/9", { id: "users/1", provider: "google-chat" });
    const code = await codeFor(linking, alice);
    expect(await linking.redeem(chat, code)).toBe("Other accounts are linked to this one: unlink them first, or link them to Alice directly.");
    expect(links.map.get("google-chat:users/1")).toBeUndefined();
  });

  // Regression (#192 review): in a shared space someone else could read the
  // code and send it twice first; it now stays with the account that sent it
  // first.
  test("once an account sent a code, it's that account's: anyone else gets it refused", async () => {
    const { linking, links } = setup();
    const code = await codeFor(linking, alice);
    await linking.redeem(chat, code);
    const other = { id: "users/2", provider: "google-chat" as const };
    expect(await linking.redeem(other, code)).toContain("That code isn't valid");
    expect(await linking.redeem(other, code)).toContain("That code isn't valid");
    expect(await linking.redeem(chat, code)).toBe("Linked: this account is now Alice.");
    expect([...links.map.keys()]).toEqual(["google-chat:users/1"]);
  });

  test("a directory that can't tell refuses the link, and the code is spent", async () => {
    const opts = { directory: true, failing: false, people: { "static:alice": { id: "alice", displayName: "Alice", roles: [] } } };
    const { linking, links } = setup(opts);
    const code = await codeFor(linking, alice);
    opts.failing = true;
    await linking.redeem(chat, code);
    expect(await linking.redeem(chat, code)).toBe("I can't check this account right now. Ask for a new code and try again in a few minutes.");
    expect(links.map.size).toBe(0);
    opts.failing = false;
    expect(await linking.redeem(chat, code)).toContain("That code isn't valid");
  });

  test("a new code replaces the owner's previous one", async () => {
    const { linking } = setup();
    const first = await codeFor(linking, alice);
    await codeFor(linking, alice);
    expect(await linking.redeem(chat, first)).toContain("That code isn't valid");
  });

  test("the owner's own account can't redeem it, nor the operator", async () => {
    const { linking } = setup();
    const code = await codeFor(linking, alice);
    expect(await linking.redeem(alice, code)).toBe("That code is for linking another account to this one.");
    expect(await linking.redeem(OPERATOR_PRINCIPAL, code)).toBe("The terminal can't link accounts.");
  });

  // No chains: an account linked to someone hands out codes for that someone.
  test("a code started from a linked account links to its owner", async () => {
    const { linking, links } = setup();
    links.link("google-chat:users/1", alice);
    const code = await codeFor(linking, chat);
    const other = { id: "users/2", provider: "google-chat" as const };
    await linking.redeem(other, code);
    await linking.redeem(other, code);
    expect(links.map.get("google-chat:users/2")).toEqual({ id: "alice", provider: "static" });
  });

  // A link must never hide that the directory knows the account as someone else.
  test("refuses an account the directory already knows as someone else, and links one it knows as the owner", async () => {
    const { linking, links } = setup({
      directory: true,
      people: {
        "static:alice": { id: "alice", displayName: "Alice", roles: [] },
        "google-chat:users/1": { id: "carol", roles: [] },
        "google-chat:users/3": { id: "alice", roles: [] },
      },
    });
    const code = await codeFor(linking, alice);
    await linking.redeem(chat, code);
    expect(await linking.redeem(chat, code)).toBe("This account belongs to someone else in the directory: it can't be linked to Alice.");
    expect(links.map.size).toBe(0);

    const again = await codeFor(linking, alice);
    const same = { id: "users/3", provider: "google-chat" as const };
    await linking.redeem(same, again);
    expect(await linking.redeem(same, again)).toBe("Linked: this account is now Alice.");
  });

  test("an account the directory doesn't know links fine on a closed instance", async () => {
    const { linking, people } = setup({ directory: true, people: { "static:alice": { id: "alice", displayName: "Alice", roles: ["r"] } } });
    expect(await people.identify(chat)).toMatchObject({ ok: false, reason: "unknown" });
    const code = await codeFor(linking, alice);
    await linking.redeem(chat, code);
    expect(await linking.redeem(chat, code)).toBe("Linked: this account is now Alice.");
    expect(await people.identify(chat)).toMatchObject({ ok: true, person: { key: "people:alice", roles: ["r"] } });
  });
});
