import { describe, expect, it } from "bun:test";
import type { Principal } from "@mercury-fw/channel-types";
import { createChannelConversations } from "./channel-conversations.ts";
import type { People } from "./people.ts";

const alice: Principal = { id: "alice", provider: "static" };

/** Identifies everyone as themselves, by their key. */
const asThemselves: People["identify"] = async (principal) => ({
  ok: true,
  operator: false,
  person: { key: `${principal.provider}:${principal.id}`, roles: [] },
});

/** An archive where `owned` lists the conversations each person has, and a store that keeps the titles saved. */
function setUp(owned: Record<string, string[]>, identify: People["identify"] = asThemselves) {
  const titles: Array<{ key: string; sessionKey: string; title: string }> = [];
  const conversations = createChannelConversations({
    identify,
    owns: async (key, sessionKey) => (owned[key] ?? []).includes(sessionKey),
    setTitle: async (key, sessionKey, title) => {
      titles.push({ key, sessionKey, title });
    },
  });
  return { conversations, titles };
}

// #214: the person renames a conversation from a UI, without the model.
describe("createChannelConversations: rename", () => {
  it("saves the title, trimmed, for the person the core identifies", async () => {
    const { conversations, titles } = setUp({ "static:alice": ["alice:a"] });
    expect(await conversations.rename(alice, "alice:a", "  Le mie issue  ")).toEqual({ ok: true, title: "Le mie issue" });
    expect(titles).toEqual([{ key: "static:alice", sessionKey: "alice:a", title: "Le mie issue" }]);
  });

  it("saves it for the linked owner, whose conversation it is", async () => {
    const { conversations, titles } = setUp(
      { "static:bob": ["alice:a"] },
      async () => ({ ok: true, operator: false, person: { key: "static:bob", roles: [] } }),
    );
    expect(await conversations.rename(alice, "alice:a", "Mia")).toEqual({ ok: true, title: "Mia" });
    expect(titles).toEqual([{ key: "static:bob", sessionKey: "alice:a", title: "Mia" }]);
  });

  it("refuses a conversation that isn't one of the person's own, as not found", async () => {
    const { conversations, titles } = setUp({ "static:bob": ["bob:a"] });
    expect(await conversations.rename(alice, "bob:a", "Mia")).toEqual({ ok: false, error: "no such conversation", notFound: true });
    expect(await conversations.rename(alice, "alice:never", "Mia")).toEqual({ ok: false, error: "no such conversation", notFound: true });
    expect(titles).toEqual([]);
  });

  it("refuses an invalid title before looking for the conversation", async () => {
    const { conversations, titles } = setUp({ "static:alice": ["alice:a"] });
    expect(await conversations.rename(alice, "alice:a", "   ")).toEqual({ ok: false, error: "the title is empty" });
    expect(await conversations.rename(alice, "alice:a", "a".repeat(101))).toEqual({
      ok: false,
      error: "the title is longer than 100 characters",
    });
    expect(await conversations.rename(alice, "alice:a", "Le mie\nissue")).toEqual({
      ok: false,
      error: "the title has a line break or another control character",
    });
    expect(titles).toEqual([]);
  });

  it("refuses someone the core doesn't admit, saving nothing", async () => {
    const { conversations, titles } = setUp({ "static:alice": ["alice:a"] }, async () => ({ ok: false, reason: "unknown", message: "no" }));
    expect(await conversations.rename(alice, "alice:a", "Mia")).toEqual({ ok: false, error: "no" });
    expect(titles).toEqual([]);
  });
});
