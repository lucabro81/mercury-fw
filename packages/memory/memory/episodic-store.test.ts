import { describe, it, expect } from "bun:test";
import type { VectorPoint } from "@mercury-fw/plugin-types";
import {
  EPISODIC_SPACE,
  ensureEpisodicSpace,
  storeEpisodicSummary,
  searchEpisodicMemory,
  getLastSessionEpisodicSummaries,
  getEpisodicSummariesBySession,
} from "./episodic-store.ts";
import { fakeVectorIndex } from "./__fixtures__/fake-vector-index.ts";

const embed = async (text: string) => [text.length, 1, 0];

function point(id: string, payload: Record<string, unknown>, vector: number[] = [1, 0, 0]): VectorPoint {
  return { id, vector, payload };
}

const summary = (sessionKey: string, text: string, timestamp: string, userId = "users/42") => ({
  userId,
  sessionKey,
  summary: text,
  timestamp,
});

describe("ensureEpisodicSpace", () => {
  // Regression test: a fresh episodic_memory collection with no payload
  // indexes made getLastSessionEpisodicSummaries's ordered/filtered scroll
  // fail the first time a brand-new deployment's context primer ran. The
  // space asks for every field it's filtered and ordered on.
  it("asks for the space with its dimensions, filtered on userId and sessionKey, ordered on timestamp", async () => {
    const index = fakeVectorIndex();
    await ensureEpisodicSpace(index, 768);
    expect(index.calls).toEqual([
      ["ensure", "episodic_memory", { dimensions: 768, keys: ["userId", "sessionKey"], ordered: ["timestamp"] }],
    ]);
    expect(EPISODIC_SPACE).toBe("episodic_memory");
  });
});

describe("storeEpisodicSummary", () => {
  it("upserts one point with the embedded summary and the full entry as payload", async () => {
    const index = fakeVectorIndex();
    const entry = summary("spaces/X:users/42", "discussed KAN-1 status", "2026-07-17T12:00:00.000Z");

    await storeEpisodicSummary(index, embed, entry);

    const [stored] = index.spaces.get("episodic_memory")!;
    expect(index.spaces.get("episodic_memory")).toHaveLength(1);
    expect(stored!.vector).toEqual([22, 1, 0]);
    expect(stored!.payload).toEqual(entry);
    expect(stored!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// The narrow need this serves: "how many times have I already notified
// this user about this item". Filtered by userId so one user's history never
// leaks into another's.
describe("searchEpisodicMemory", () => {
  it("embeds the query, searches only the person's summaries, nearest first", async () => {
    const index = fakeVectorIndex({
      episodic_memory: [
        point("a", summary("s1", "far", "2026-07-01T00:00:00.000Z"), [0, 1, 0]),
        point("b", summary("s2", "near", "2026-07-02T00:00:00.000Z"), [1, 0, 0]),
        point("c", summary("s3", "someone else's", "2026-07-03T00:00:00.000Z", "users/7"), [1, 0, 0]),
      ],
    });

    const found = await searchEpisodicMemory(index, async () => [1, 0, 0], { userId: "users/42", queryText: "KAN-1" });

    expect(found).toEqual([summary("s2", "near", "2026-07-02T00:00:00.000Z"), summary("s1", "far", "2026-07-01T00:00:00.000Z")]);
    expect(index.calls).toEqual([["query", "episodic_memory", { vector: [1, 0, 0], where: { userId: "users/42" }, limit: 5 }]]);
  });

  it("asks for a custom limit instead of the default", async () => {
    const index = fakeVectorIndex();
    await searchEpisodicMemory(index, embed, { userId: "users/42", queryText: "x", limit: 12 });
    expect((index.calls[0]![2] as { limit: number }).limit).toBe(12);
  });

  it("skips points with a malformed payload instead of throwing", async () => {
    const index = fakeVectorIndex({
      episodic_memory: [point("a", { userId: "users/42" }), point("b", summary("s", "ok", "2026-07-01T00:00:00.000Z"))],
    });
    expect(await searchEpisodicMemory(index, embed, { userId: "users/42", queryText: "x" })).toEqual([
      summary("s", "ok", "2026-07-01T00:00:00.000Z"),
    ]);
  });
});

describe("getLastSessionEpisodicSummaries", () => {
  const seeded = () =>
    fakeVectorIndex({
      episodic_memory: [
        point("1", summary("session-A", "older session", "2026-07-20T10:00:00.000Z")),
        point("2", summary("session-B", "B first", "2026-07-25T17:00:00.000Z")),
        point("3", summary("session-B", "B last", "2026-07-25T18:00:00.000Z")),
        point("4", summary("session-C", "someone else's newer one", "2026-07-26T00:00:00.000Z", "users/7")),
      ],
    });

  it("returns the person's most recent session's entries only, newest first", async () => {
    expect(await getLastSessionEpisodicSummaries(seeded(), { userId: "users/42" })).toEqual([
      summary("session-B", "B last", "2026-07-25T18:00:00.000Z"),
      summary("session-B", "B first", "2026-07-25T17:00:00.000Z"),
    ]);
  });

  // Regression guard: the session boundary is enforced by the query the
  // index gets, not assumed — otherwise an earlier session's entries could
  // leak into a brand-new session's primer just because they're also recent.
  it("scopes the second scroll to the most recent entry's own sessionKey", async () => {
    const index = seeded();
    await getLastSessionEpisodicSummaries(index, { userId: "users/42", limit: 2 });
    expect(index.calls).toEqual([
      ["scroll", "episodic_memory", { where: { userId: "users/42" }, orderBy: { key: "timestamp", direction: "desc" }, limit: 1 }],
      [
        "scroll",
        "episodic_memory",
        { where: { userId: "users/42", sessionKey: "session-B" }, orderBy: { key: "timestamp", direction: "desc" }, limit: 2 },
      ],
    ]);
  });

  it("is empty when the person has no episodic history", async () => {
    expect(await getLastSessionEpisodicSummaries(fakeVectorIndex(), { userId: "users/42" })).toEqual([]);
  });

  it("is empty when the most recent point is malformed, and skips malformed ones in the session", async () => {
    const malformedLatest = fakeVectorIndex({ episodic_memory: [point("x", { userId: "users/42", timestamp: "2026-08-01T00:00:00.000Z" })] });
    expect(await getLastSessionEpisodicSummaries(malformedLatest, { userId: "users/42" })).toEqual([]);

    const index = fakeVectorIndex({
      episodic_memory: [
        point("1", { userId: "users/42", sessionKey: "B", timestamp: "2026-07-25T17:00:00.000Z" }),
        point("2", summary("B", "ok", "2026-07-25T18:00:00.000Z")),
      ],
    });
    expect(await getLastSessionEpisodicSummaries(index, { userId: "users/42" })).toEqual([summary("B", "ok", "2026-07-25T18:00:00.000Z")]);
  });
});

describe("getEpisodicSummariesBySession", () => {
  it("returns the summaries of one conversation of the person, oldest first, skipping malformed ones", async () => {
    const index = fakeVectorIndex({
      episodic_memory: [
        point("b", summary("alice:conv-1", "secondo", "2026-10-12T10:00:02.000Z", "static:alice")),
        point("x", { userId: "static:alice", sessionKey: "alice:conv-1" }),
        point("a", summary("alice:conv-1", "primo", "2026-10-12T10:00:01.000Z", "static:alice")),
        point("o", summary("alice:conv-2", "altra", "2026-10-12T10:00:00.000Z", "static:alice")),
      ],
    });

    const summaries = await getEpisodicSummariesBySession(index, { userId: "static:alice", sessionKey: "alice:conv-1" });

    expect(summaries).toEqual([
      summary("alice:conv-1", "primo", "2026-10-12T10:00:01.000Z", "static:alice"),
      summary("alice:conv-1", "secondo", "2026-10-12T10:00:02.000Z", "static:alice"),
    ]);
    expect(index.calls).toEqual([
      [
        "scroll",
        "episodic_memory",
        { where: { userId: "static:alice", sessionKey: "alice:conv-1" }, orderBy: { key: "timestamp", direction: "asc" }, limit: 100 },
      ],
    ]);
  });
});
