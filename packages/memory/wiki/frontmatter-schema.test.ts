import { describe, it, expect } from "bun:test";
import { CuratedFrontmatterSchema, InferredFrontmatterSchema, PersonalFrontmatterSchema } from "./frontmatter-schema.ts";

describe("CuratedFrontmatterSchema", () => {
  it("accepts a minimal curated frontmatter", () => {
    const result = CuratedFrontmatterSchema.safeParse({ type: "curated" });
    expect(result.success).toBe(true);
  });

  it("accepts a curated frontmatter with author/last_updated", () => {
    const result = CuratedFrontmatterSchema.safeParse({
      type: "curated",
      author: "luca",
      last_updated: "2026-07-16",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a frontmatter with the wrong type literal", () => {
    const result = CuratedFrontmatterSchema.safeParse({ type: "seed" });
    expect(result.success).toBe(false);
  });
});

describe("InferredFrontmatterSchema", () => {
  it("accepts a valid inferred frontmatter", () => {
    const result = InferredFrontmatterSchema.safeParse({
      type: "inferred",
      source: "agent",
      confidence: "medium",
      derived_from: ["ep_a1b2", "ep_c3d4"],
      last_reviewed: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects inferred frontmatter missing confidence", () => {
    const result = InferredFrontmatterSchema.safeParse({
      type: "inferred",
      source: "agent",
      derived_from: ["ep_a1b2"],
      last_reviewed: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid confidence value", () => {
    const result = InferredFrontmatterSchema.safeParse({
      type: "inferred",
      source: "agent",
      confidence: "very-high",
      derived_from: ["ep_a1b2"],
      last_reviewed: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects inferred frontmatter with an empty derived_from", () => {
    const result = InferredFrontmatterSchema.safeParse({
      type: "inferred",
      source: "agent",
      confidence: "low",
      derived_from: [],
      last_reviewed: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects inferred frontmatter missing derived_from entirely", () => {
    const result = InferredFrontmatterSchema.safeParse({
      type: "inferred",
      source: "agent",
      confidence: "low",
      last_reviewed: null,
    });
    expect(result.success).toBe(false);
  });
});


describe("the status fields a reviewed note carries", () => {
  const status = { status: "contested", verified_at: "2026-11-14T04:00:00.000Z", evidence: ["turn-1", "turn-2"], validated_at: "2026-11-15T10:00:00.000Z" };
  const inferred = { type: "inferred", source: "agent", confidence: "low", derived_from: ["a"], last_reviewed: null };

  it("are accepted on a curated, a personal and an inferred note, and kept as written", () => {
    expect(CuratedFrontmatterSchema.parse({ type: "curated", ...status })).toEqual({ type: "curated", ...status });
    expect(PersonalFrontmatterSchema.parse({ type: "personal", ...status })).toEqual({ type: "personal", ...status });
    expect(InferredFrontmatterSchema.parse({ ...inferred, ...status })).toEqual({ ...inferred, ...status });
  });

  it("take each of the four statuses", () => {
    for (const s of ["unverified", "verified", "contested", "validated"]) {
      expect(CuratedFrontmatterSchema.safeParse({ type: "curated", status: s }).success).toBe(true);
    }
  });

  it("refuse a status outside the four", () => {
    expect(CuratedFrontmatterSchema.safeParse({ type: "curated", status: "wrong" }).success).toBe(false);
  });

  it("refuse evidence that isn't a list of turn ids", () => {
    expect(CuratedFrontmatterSchema.safeParse({ type: "curated", evidence: "turn-1" }).success).toBe(false);
  });
});

describe("locked", () => {
  it("is accepted as true on a curated and a personal note", () => {
    expect(CuratedFrontmatterSchema.parse({ type: "curated", locked: true })).toEqual({ type: "curated", locked: true });
    expect(PersonalFrontmatterSchema.parse({ type: "personal", locked: true })).toEqual({ type: "personal", locked: true });
  });

  it("refuses anything but true (an unlocked note has no field)", () => {
    expect(CuratedFrontmatterSchema.safeParse({ type: "curated", locked: false }).success).toBe(false);
    expect(CuratedFrontmatterSchema.safeParse({ type: "curated", locked: "yes" }).success).toBe(false);
  });

  it("isn't a field of an inferred note: only people lock, and inferred notes are the consolidation's", () => {
    const parsed = InferredFrontmatterSchema.parse({ type: "inferred", source: "agent", confidence: "low", derived_from: ["a"], last_reviewed: null, locked: true });
    expect("locked" in parsed).toBe(false);
  });
});
