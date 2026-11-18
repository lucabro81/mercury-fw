/**
 * The __TITLE__ store, against what the contract asks of every store: one
 * conversation's messages in time order, paged, never another person's; the
 * person's newest across their conversations; titles, the newest replacing
 * the one before.
 */
import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "@mercury-fw/kit";
import { createStore } from "./index.ts";

/** A message of `userId`'s conversation `sessionKey`, written at minute `minute`. */
function message(id: string, userId: string, sessionKey: string, minute: number): StoredMessage {
  return { id, userId, sessionKey, timestamp: `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`, role: "user", content: id };
}

/** A store holding three of ada's messages in s1, one in s2, one of bob's in s1. */
async function storeWithMessages() {
  const store = createStore();
  await store.ready();
  for (const m of [message("a2", "ada", "s1", 2), message("a1", "ada", "s1", 1), message("a3", "ada", "s1", 3), message("a4", "ada", "s2", 4), message("b1", "bob", "s1", 5)]) {
    await store.append(m);
  }
  return store;
}

describe("createStore", () => {
  test("reads a conversation in time order, either way", async () => {
    const store = await storeWithMessages();
    const asc = await store.messages({ userId: "ada", sessionKey: "s1", order: "asc", limit: 10 });
    expect(asc.messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    const desc = await store.messages({ userId: "ada", sessionKey: "s1", order: "desc", limit: 10 });
    expect(desc.messages.map((m) => m.id)).toEqual(["a3", "a2", "a1"]);
  });

  test("pages a conversation with a cursor", async () => {
    const store = await storeWithMessages();
    const first = await store.messages({ userId: "ada", sessionKey: "s1", order: "asc", limit: 2 });
    const second = await store.messages({ userId: "ada", sessionKey: "s1", order: "asc", limit: 2, cursor: first.next! });
    expect([first.messages.map((m) => m.id), second.messages.map((m) => m.id), second.next]).toEqual([["a1", "a2"], ["a3"], undefined]);
  });

  test("never reads another person's messages", async () => {
    const store = await storeWithMessages();
    expect((await store.messages({ userId: "bob", sessionKey: "s1", order: "asc", limit: 10 })).messages.map((m) => m.id)).toEqual(["b1"]);
  });

  test("reads the person's newest across their conversations", async () => {
    const store = await storeWithMessages();
    expect((await store.recent({ userId: "ada", limit: 2 })).map((m) => m.id)).toEqual(["a4", "a3"]);
  });

  test("keeps a title per conversation, the newest replacing the one before", async () => {
    const store = await storeWithMessages();
    await store.setTitle({ userId: "ada", sessionKey: "s1", title: "Printer", source: "generated", updatedAt: "2026-01-01T11:00:00.000Z" });
    await store.setTitle({ userId: "ada", sessionKey: "s1", title: "The printer", source: "person", updatedAt: "2026-01-01T12:00:00.000Z" });
    expect(await store.titles({ userId: "ada", sessionKeys: ["s1", "s2"] })).toEqual([
      { userId: "ada", sessionKey: "s1", title: "The printer", source: "person", updatedAt: "2026-01-01T12:00:00.000Z" },
    ]);
    expect(await store.titles({ userId: "bob", sessionKeys: ["s1"] })).toEqual([]);
  });
});
