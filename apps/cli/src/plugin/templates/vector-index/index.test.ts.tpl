/**
 * The __TITLE__ index, against what the contract asks of every index: spaces
 * made once, points replaced by id, the nearest first within a filter, pages
 * in order, payloads rewritten where a filter says.
 */
import { describe, expect, test } from "bun:test";
import { createIndex } from "./index.ts";

const SPEC = { dimensions: 2, keys: ["person"], ordered: ["at"] };

/** An index with a space `notes` holding three points. */
async function indexWithNotes() {
  const index = createIndex();
  await index.ensure("notes", SPEC);
  await index.upsert("notes", [
    { id: "1", vector: [1, 0], payload: { person: "ada", at: "2026-01-01" } },
    { id: "2", vector: [0, 1], payload: { person: "ada", at: "2026-01-02" } },
    { id: "3", vector: [1, 0], payload: { person: "bob", at: "2026-01-03" } },
  ]);
  return index;
}

describe("createIndex", () => {
  test("answers with the nearest points first, within the filter", async () => {
    const index = await indexWithNotes();
    const found = await index.query("notes", { vector: [1, 0.1], where: { person: "ada" }, limit: 2 });
    expect(found.map((p) => p.id)).toEqual(["1", "2"]);
  });

  test("replaces a point with the same id", async () => {
    const index = await indexWithNotes();
    await index.upsert("notes", [{ id: "1", vector: [0, 1], payload: { person: "ada", at: "2026-01-04" } }]);
    expect((await index.scroll("notes", { where: { person: "ada" }, limit: 10 })).points).toHaveLength(2);
  });

  test("pages in order, with a cursor to the next page", async () => {
    const index = await indexWithNotes();
    const first = await index.scroll("notes", { orderBy: { key: "at", direction: "desc" }, limit: 2 });
    expect(first.points.map((p) => p.id)).toEqual(["3", "2"]);
    const second = await index.scroll("notes", { orderBy: { key: "at", direction: "desc" }, limit: 2, cursor: first.next! });
    expect(second).toEqual({ points: [{ id: "1", payload: { person: "ada", at: "2026-01-01" } }] });
  });

  test("rewrites the payload of the points the filter selects, keeping the rest", async () => {
    const index = await indexWithNotes();
    await index.setPayload("notes", { where: { person: "bob" }, payload: { person: "robert" } });
    expect((await index.scroll("notes", { where: { person: "robert" }, limit: 10 })).points).toEqual([{ id: "3", payload: { person: "robert", at: "2026-01-03" } }]);
  });

  test("refuses a vector of another length, and a space never made", async () => {
    const index = await indexWithNotes();
    await expect(index.upsert("notes", [{ id: "4", vector: [1, 2, 3], payload: {} }])).rejects.toThrow('"notes" takes vectors of 2, not 3');
    await expect(index.query("missing", { vector: [1, 0], limit: 1 })).rejects.toThrow('no space "missing": ensure it first');
  });

  test("making a space again keeps its points", async () => {
    const index = await indexWithNotes();
    await index.ensure("notes", SPEC);
    expect((await index.scroll("notes", { limit: 10 })).points).toHaveLength(3);
  });
});
