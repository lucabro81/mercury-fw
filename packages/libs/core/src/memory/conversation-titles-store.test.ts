import { describe, it, expect } from "bun:test";
import {
  cleanGeneratedTitle,
  MAX_TITLE_LENGTH,
  setTitle,
  titleError,
  titleOf,
  titlesOf,
} from "./conversation-titles-store.ts";
import { fakeConversationStore } from "./__fixtures__/fake-conversation-store.ts";

describe("cleanGeneratedTitle", () => {
  it("keeps a plain title as it is", () => {
    expect(cleanGeneratedTitle("Issue aperte su KAN")).toBe("Issue aperte su KAN");
  });

  it("trims whitespace around the title", () => {
    expect(cleanGeneratedTitle("  \n Issue aperte  \n")).toBe("Issue aperte");
  });

  it("keeps only the first non-empty line", () => {
    expect(cleanGeneratedTitle("\n\nIssue aperte\nThis title sums up the request")).toBe("Issue aperte");
  });

  it("strips quotes wrapped around the title, nested too", () => {
    expect(cleanGeneratedTitle('"Issue aperte"')).toBe("Issue aperte");
    expect(cleanGeneratedTitle("'Issue aperte'")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("“Issue aperte”")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("«Issue aperte»")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("\"'Issue aperte'\"")).toBe("Issue aperte");
  });

  it("keeps quotes inside the title", () => {
    expect(cleanGeneratedTitle('La pagina "Onboarding"')).toBe('La pagina "Onboarding"');
  });

  it("strips Markdown: a heading mark, emphasis and code marks", () => {
    expect(cleanGeneratedTitle("## Issue aperte")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("**Issue aperte**")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("Il comando `jira issue list`")).toBe("Il comando jira issue list");
  });

  it("keeps a # that isn't a heading mark", () => {
    expect(cleanGeneratedTitle("Note su C#")).toBe("Note su C#");
  });

  it("drops a trailing period or colon", () => {
    expect(cleanGeneratedTitle("Issue aperte.")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("Issue aperte:")).toBe("Issue aperte");
  });

  it("keeps a trailing question mark", () => {
    expect(cleanGeneratedTitle("Chi è di turno?")).toBe("Chi è di turno?");
  });

  it("drops a label the model puts before the title", () => {
    expect(cleanGeneratedTitle("Title: Issue aperte")).toBe("Issue aperte");
    expect(cleanGeneratedTitle("Titolo: Issue aperte")).toBe("Issue aperte");
  });

  it("cuts a long title on a word boundary, with an ellipsis, within the limit", () => {
    const words = Array.from({ length: 40 }, (_, i) => `parola${i}`).join(" ");
    const cut = cleanGeneratedTitle(words);
    expect(cut.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(cut.endsWith("…")).toBe(true);
    expect(words.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.slice(0, -1).endsWith(" ")).toBe(false);
    // The word before the ellipsis is whole.
    expect(words.split(" ")).toContain(cut.slice(0, -1).split(" ").at(-1) ?? "");
  });

  it("cuts a single word longer than the limit on the limit", () => {
    const cut = cleanGeneratedTitle("x".repeat(300));
    expect(cut).toBe(`${"x".repeat(MAX_TITLE_LENGTH - 1)}…`);
  });

  it("keeps a title exactly at the limit whole", () => {
    const exact = "a".repeat(MAX_TITLE_LENGTH);
    expect(cleanGeneratedTitle(exact)).toBe(exact);
  });

  it("drops control characters", () => {
    expect(cleanGeneratedTitle("Issue\u0007 aperte")).toBe("Issue aperte");
  });

  it("gives an empty string when nothing is left", () => {
    expect(cleanGeneratedTitle("")).toBe("");
    expect(cleanGeneratedTitle("   \n  ")).toBe("");
    expect(cleanGeneratedTitle('""')).toBe("");
    expect(cleanGeneratedTitle("**")).toBe("");
  });
});

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
