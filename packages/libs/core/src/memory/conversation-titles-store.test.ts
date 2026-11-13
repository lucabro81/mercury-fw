import { describe, it, expect } from "bun:test";
import {
  MAX_TITLE_LENGTH,
  setTitle,
  titleError,
  titleOf,
  titlesOf,
} from "./conversation-titles-store.ts";
import { fakeConversationStore } from "./__fixtures__/fake-conversation-store.ts";

describe("titleError", () => {
  it("accepts an ordinary title", () => {
    expect(titleError("Le mie issue")).toBeUndefined();
  });

  it("accepts a title exactly at the limit", () => {
    expect(titleError("a".repeat(MAX_TITLE_LENGTH))).toBeUndefined();
  });

  it("refuses an empty title", () => {
    expect(titleError("")).toBe("the title is empty");
  });

  it("refuses a title longer than the limit", () => {
    expect(titleError("a".repeat(MAX_TITLE_LENGTH + 1))).toBe(`the title is longer than ${MAX_TITLE_LENGTH} characters`);
  });

  it("refuses a line break or another control character", () => {
    expect(titleError("Le mie\nissue")).toBe("the title has a line break or another control character");
    expect(titleError("Le mie\u2028issue")).toBe("the title has a line break or another control character");
    expect(titleError("Le mie\u0000issue")).toBe("the title has a line break or another control character");
  });
});

describe("setTitle / titleOf / titlesOf", () => {
  const now = () => new Date("2026-11-05T10:00:00.000Z");

  it("saves the title of the person's conversation with who gave it and when", async () => {
    const store = fakeConversationStore();
    await setTitle(store, { userId: "u1", sessionKey: "u1:a", title: "Issue aperte", source: "generated" }, now);
    expect(store.calls).toEqual([
      ["setTitle", { userId: "u1", sessionKey: "u1:a", title: "Issue aperte", source: "generated", updatedAt: "2026-11-05T10:00:00.000Z" }],
    ]);
  });

  it("the newest title of a conversation is the one read back", async () => {
    const store = fakeConversationStore();
    await setTitle(store, { userId: "u1", sessionKey: "u1:a", title: "Issue aperte", source: "generated" }, now);
    await setTitle(store, { userId: "u1", sessionKey: "u1:a", title: "Le mie issue", source: "person" }, now);
    expect(await titleOf(store, { userId: "u1", sessionKey: "u1:a" })).toEqual({ title: "Le mie issue", source: "person" });
  });

  it("titleOf is undefined for a conversation with no title", async () => {
    expect(await titleOf(fakeConversationStore(), { userId: "u1", sessionKey: "u1:a" })).toBeUndefined();
  });

  it("titlesOf gives the titles of the listed conversations, by session key", async () => {
    const store = fakeConversationStore();
    await setTitle(store, { userId: "u1", sessionKey: "u1:a", title: "A", source: "generated" }, now);
    await setTitle(store, { userId: "u1", sessionKey: "u1:b", title: "B", source: "person" }, now);
    await setTitle(store, { userId: "u1", sessionKey: "u1:c", title: "C", source: "generated" }, now);
    const titles = await titlesOf(store, { userId: "u1", sessionKeys: ["u1:a", "u1:b", "u1:z"] });
    expect(titles).toEqual(
      new Map([
        ["u1:a", { title: "A", source: "generated" }],
        ["u1:b", { title: "B", source: "person" }],
      ]),
    );
    expect(store.calls.at(-1)).toEqual(["titles", { userId: "u1", sessionKeys: ["u1:a", "u1:b", "u1:z"] }]);
  });

  it("titlesOf never gives another person's title, even for the same session key", async () => {
    const store = fakeConversationStore();
    await setTitle(store, { userId: "u2", sessionKey: "shared", title: "Altrui", source: "person" }, now);
    expect(await titlesOf(store, { userId: "u1", sessionKeys: ["shared"] })).toEqual(new Map());
    expect(await titleOf(store, { userId: "u1", sessionKey: "shared" })).toBeUndefined();
  });

  it("titlesOf asks nothing for no conversations", async () => {
    const store = fakeConversationStore();
    expect(await titlesOf(store, { userId: "u1", sessionKeys: [] })).toEqual(new Map());
    expect(store.calls).toEqual([]);
  });

  it("skips a title whose source isn't the model's or the person's", async () => {
    const store = fakeConversationStore([], [{ userId: "u1", sessionKey: "u1:b", title: "B", source: "someone", updatedAt: "t" }]);
    expect(await titlesOf(store, { userId: "u1", sessionKeys: ["u1:b"] })).toEqual(new Map());
  });
});
