import { describe, expect, it } from "bun:test";
import { legacyUserKey, migrateMemoryToUserKeys, type MigrationIndex } from "./migrate-layout.ts";

describe("legacyUserKey", () => {
  it("attributes a Google Chat id, encoded once, twice or not at all, and the terminal", () => {
    expect(legacyUserKey("users/42")).toBe("google-chat:users/42");
    expect(legacyUserKey("users%2F42")).toBe("google-chat:users/42");
    expect(legacyUserKey("users%252F42")).toBe("google-chat:users/42");
    expect(legacyUserKey("terminal")).toBe("none:terminal");
  });

  it("can't attribute anything else: an id without its provider could be anyone's", () => {
    for (const id of ["alice", "conv-1", "users/42/x", "users/", "%E0%A4%A", "static:alice", "google-chat:users/42"]) {
      expect(legacyUserKey(id)).toBeUndefined();
    }
  });
});

/** An index fake holding the `userId`s of each space's points, paging scrolls by `pageSize`, recording every setPayload. */
function fakeIndex(points: Record<string, string[]>, pageSize = 2) {
  const updates: Array<{ space: string; userId: string; key: string }> = [];
  const index: MigrationIndex = {
    scroll: async (space, q) => {
      const all = points[space];
      if (all === undefined) throw new Error(`Not found: Collection ${space} doesn't exist`);
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
      const result = { points: page.map((userId, i) => ({ id: String(start + i), payload: { userId } })) };
      return next === undefined ? result : { ...result, next };
    },
    setPayload: async (space, q) => {
      const userId = q.where.userId!;
      const key = q.payload.userId as string;
      updates.push({ space, userId, key });
      points[space] = points[space]!.map((u) => (u === userId ? key : u));
    },
  };
  return { index, updates };
}

describe("migrateMemoryToUserKeys", () => {
  const spaces = ["episodic_memory", "semantic_facts", "verbatim_archive"];

  it("rewrites every legacy userId it can attribute to its user key, across pages and spaces", async () => {
    const { index, updates } = fakeIndex({
      episodic_memory: ["users/42", "users/42", "users/7"],
      semantic_facts: ["users/42"],
      // The archive stored the id encoded.
      verbatim_archive: ["users%2F42", "users%2F42", "users%2F7"],
    });
    const logs: string[] = [];

    await migrateMemoryToUserKeys(index, spaces, (m) => logs.push(m));

    expect(updates).toEqual([
      { space: "episodic_memory", userId: "users/42", key: "google-chat:users/42" },
      { space: "episodic_memory", userId: "users/7", key: "google-chat:users/7" },
      { space: "semantic_facts", userId: "users/42", key: "google-chat:users/42" },
      { space: "verbatim_archive", userId: "users%2F42", key: "google-chat:users/42" },
      { space: "verbatim_archive", userId: "users%2F7", key: "google-chat:users/7" },
    ]);
    expect(logs).toEqual(["rewrote 5 legacy userIds to user keys"]);
  });

  it("leaves user keys alone and what it can't attribute, saying so once per id", async () => {
    const { index, updates } = fakeIndex({
      episodic_memory: ["google-chat:users/42", "alice", "alice"],
      semantic_facts: [],
      verbatim_archive: ["static:bob"],
    });
    const logs: string[] = [];

    await migrateMemoryToUserKeys(index, spaces, (m) => logs.push(m));

    expect(updates).toEqual([]);
    expect(logs).toEqual(['episodic_memory: left userId "alice" as it is: can\'t tell whose it is (an id without its provider)']);
  });

  it("goes on with the other spaces when one fails, and says which", async () => {
    const { index, updates } = fakeIndex({ semantic_facts: ["users/42"], verbatim_archive: [] });
    const logs: string[] = [];

    await migrateMemoryToUserKeys(index, spaces, (m) => logs.push(m));

    expect(updates).toEqual([{ space: "semantic_facts", userId: "users/42", key: "google-chat:users/42" }]);
    expect(logs[0]).toStartWith("episodic_memory: migration skipped: ");
    expect(logs[1]).toBe("rewrote 1 legacy userIds to user keys");
  });
});
