import { describe, it, expect } from "bun:test";
import {
  cleanGeneratedTitle,
  ensureTitlesCollection,
  MAX_TITLE_LENGTH,
  setTitle,
  titleError,
  titleOf,
  titlePointId,
  titlesOf,
} from "./conversation-titles-store.ts";
import type { QdrantClientLike } from "./episodic-store.ts";

/** A fake client keeping upserted points by id, whose scroll applies the `userId` + `sessionKey` filters the store sends. */
function fakeClient(opts: { scroll?: boolean } = {}) {
  const points = new Map<string, Record<string, unknown>>();
  const scrolls: unknown[] = [];
  const created: unknown[] = [];
  const indexes: unknown[] = [];
  const client: QdrantClientLike = {
    getCollections: async () => ({ collections: [] }),
    createCollection: async (name, params) => {
      created.push({ name, params });
      return {};
    },
    upsert: async (_name, params) => {
      for (const p of params.points) points.set(p.id, { ...p.payload, __vector: p.vector });
      return {};
    },
    query: async () => ({ points: [] }),
    createPayloadIndex: async (name, params) => {
      indexes.push({ name, params });
      return {};
    },
  };
  if (opts.scroll !== false) {
    client.scroll = async (name, params) => {
      scrolls.push({ name, params });
      const must = (params.filter as { must: Array<{ key: string; match: { value?: string; any?: string[] } }> }).must;
      const hits = [...points.entries()].filter(([, payload]) =>
        must.every((c) => (c.match.any ? c.match.any.includes(payload[c.key] as string) : payload[c.key] === c.match.value)),
      );
      return { points: hits.slice(0, params.limit).map(([id, payload]) => ({ id, payload })) };
    };
  }
  return { client, points, scrolls, created, indexes };
}

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

describe("titlePointId", () => {
  it("is a UUID", () => {
    expect(titlePointId("google:1", "google:1:abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is the same for the same conversation of the same person", () => {
    expect(titlePointId("google:1", "google:1:abc")).toBe(titlePointId("google:1", "google:1:abc"));
  });

  it("differs between conversations and between people", () => {
    const ids = new Set([
      titlePointId("google:1", "google:1:abc"),
      titlePointId("google:1", "google:1:abd"),
      titlePointId("google:2", "google:1:abc"),
    ]);
    expect(ids.size).toBe(3);
  });

  it("doesn't confuse a boundary between the person and the conversation", () => {
    expect(titlePointId("a:b", "c")).not.toBe(titlePointId("a", "b:c"));
  });
});

describe("ensureTitlesCollection", () => {
  it("creates the collection with a 1-dimension vector and indexes userId and sessionKey", async () => {
    const { client, created, indexes } = fakeClient();
    await ensureTitlesCollection(client, "conversation_titles");
    expect(created).toEqual([{ name: "conversation_titles", params: { vectors: { size: 1, distance: "Dot" } } }]);
    expect(indexes).toEqual([
      { name: "conversation_titles", params: { field_name: "userId", field_schema: "keyword" } },
      { name: "conversation_titles", params: { field_name: "sessionKey", field_schema: "keyword" } },
    ]);
  });

  it("doesn't recreate an existing collection, and still ensures the indexes", async () => {
    const { client, created, indexes } = fakeClient();
    client.getCollections = async () => ({ collections: [{ name: "conversation_titles" }] });
    await ensureTitlesCollection(client, "conversation_titles");
    expect(created).toEqual([]);
    expect(indexes).toHaveLength(2);
  });
});

describe("setTitle / titleOf / titlesOf", () => {
  const now = () => new Date("2026-11-05T10:00:00.000Z");

  it("stores one point per conversation at its deterministic id, with what was saved", async () => {
    const { client, points } = fakeClient();
    await setTitle(client, "t", { userId: "u1", sessionKey: "u1:a", title: "Issue aperte", source: "generated" }, now);
    expect([...points.entries()]).toEqual([
      [
        titlePointId("u1", "u1:a"),
        {
          userId: "u1",
          sessionKey: "u1:a",
          title: "Issue aperte",
          source: "generated",
          updatedAt: "2026-11-05T10:00:00.000Z",
          __vector: [1],
        },
      ],
    ]);
  });

  it("replaces the title of the same conversation instead of adding one", async () => {
    const { client, points } = fakeClient();
    await setTitle(client, "t", { userId: "u1", sessionKey: "u1:a", title: "Issue aperte", source: "generated" }, now);
    await setTitle(client, "t", { userId: "u1", sessionKey: "u1:a", title: "Le mie issue", source: "person" }, now);
    expect(points.size).toBe(1);
    expect(await titleOf(client, "t", { userId: "u1", sessionKey: "u1:a" })).toEqual({ title: "Le mie issue", source: "person" });
  });

  it("titleOf is undefined for a conversation with no title", async () => {
    const { client } = fakeClient();
    expect(await titleOf(client, "t", { userId: "u1", sessionKey: "u1:a" })).toBeUndefined();
  });

  it("titlesOf gives the titles of the listed conversations, by session key", async () => {
    const { client, scrolls } = fakeClient();
    await setTitle(client, "t", { userId: "u1", sessionKey: "u1:a", title: "A", source: "generated" }, now);
    await setTitle(client, "t", { userId: "u1", sessionKey: "u1:b", title: "B", source: "person" }, now);
    await setTitle(client, "t", { userId: "u1", sessionKey: "u1:c", title: "C", source: "generated" }, now);
    const titles = await titlesOf(client, "t", { userId: "u1", sessionKeys: ["u1:a", "u1:b", "u1:z"] });
    expect(titles).toEqual(
      new Map([
        ["u1:a", { title: "A", source: "generated" }],
        ["u1:b", { title: "B", source: "person" }],
      ]),
    );
    expect(scrolls).toEqual([
      {
        name: "t",
        params: {
          filter: {
            must: [
              { key: "userId", match: { value: "u1" } },
              { key: "sessionKey", match: { any: ["u1:a", "u1:b", "u1:z"] } },
            ],
          },
          limit: 3,
          with_payload: true,
        },
      },
    ]);
  });

  it("titlesOf never gives another person's title, even for the same session key", async () => {
    const { client } = fakeClient();
    await setTitle(client, "t", { userId: "u2", sessionKey: "shared", title: "Altrui", source: "person" }, now);
    expect(await titlesOf(client, "t", { userId: "u1", sessionKeys: ["shared"] })).toEqual(new Map());
    expect(await titleOf(client, "t", { userId: "u1", sessionKey: "shared" })).toBeUndefined();
  });

  it("titlesOf asks nothing for no conversations", async () => {
    const { client, scrolls } = fakeClient();
    expect(await titlesOf(client, "t", { userId: "u1", sessionKeys: [] })).toEqual(new Map());
    expect(scrolls).toEqual([]);
  });

  it("skips a malformed point", async () => {
    const { client, points } = fakeClient();
    points.set("x", { userId: "u1", sessionKey: "u1:a", title: 42, source: "generated" });
    points.set("y", { userId: "u1", sessionKey: "u1:b", title: "B", source: "someone" });
    expect(await titlesOf(client, "t", { userId: "u1", sessionKeys: ["u1:a", "u1:b"] })).toEqual(new Map());
  });

  it("reads nothing from a client that can't scroll", async () => {
    const { client } = fakeClient({ scroll: false });
    await setTitle(client, "t", { userId: "u1", sessionKey: "u1:a", title: "A", source: "generated" }, now);
    expect(await titlesOf(client, "t", { userId: "u1", sessionKeys: ["u1:a"] })).toEqual(new Map());
    expect(await titleOf(client, "t", { userId: "u1", sessionKey: "u1:a" })).toBeUndefined();
  });
});
