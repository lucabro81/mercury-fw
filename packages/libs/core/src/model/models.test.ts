/**
 * Tests for the models an instance declares (`models` in its config): the
 * handles `ollamaModel`/`ollamaEmbedding` return, refused at once when they
 * can't work, and how the core turns them into the models each role uses —
 * one model per handle, `background` on `turn` when left out.
 */
import { describe, expect, test } from "bun:test";
import { ollamaEmbedding, ollamaModel, resolveModels, type ModelProvider } from "./models.ts";

/** A provider recording what it was asked to build; each model is a tagged object. */
function fakeProvider() {
  const built: Array<{ kind: string; name: string; settings?: unknown }> = [];
  const provider: ModelProvider = {
    language: (name, settings) => {
      built.push({ kind: "language", name, settings });
      return { tag: `language:${name}:${built.length}` } as never;
    },
    embedding: (name) => {
      built.push({ kind: "embedding", name });
      return { tag: `embedding:${name}:${built.length}` } as never;
    },
  };
  return { provider, built };
}

describe("ollamaModel", () => {
  test("a handle with its name, its settings as given, capacity 1 when left out", () => {
    expect(ollamaModel("qwen3.8:27b")).toEqual({
      provider: "ollama",
      kind: "language",
      name: "qwen3.8:27b",
      settings: {},
      capacity: 1,
      backgroundSlots: 1,
    });
  });

  test("settings and capacity as declared; entries left undefined (empty variables) are dropped", () => {
    const handle = ollamaModel("gemma4:12b", { think: false, temperature: 0.2, topP: undefined, topK: 20, capacity: 8 });
    expect(handle).toEqual({
      provider: "ollama",
      kind: "language",
      name: "gemma4:12b",
      settings: { think: false, temperature: 0.2, topK: 20 },
      capacity: 8,
      backgroundSlots: 1,
    });
    expect(Object.keys(handle.settings)).toEqual(["think", "temperature", "topK"]);
  });

  test("capacity left undefined (an empty variable) is 1", () => {
    expect(ollamaModel("m", { capacity: undefined }).capacity).toBe(1);
  });

  test("the handle can't be changed afterwards", () => {
    const handle = ollamaModel("m", { temperature: 0.2 });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.settings)).toBe(true);
  });

  test("an empty or missing name stops the start", () => {
    for (const name of [undefined, "", "   "]) {
      expect(() => ollamaModel(name)).toThrow(
        "ollamaModel needs the model's name and got none: is the variable it's read from set?",
      );
    }
  });

  test("a setting out of its range stops the start, naming the model and the entry", () => {
    expect(() => ollamaModel("qwen", { temperature: -1 })).toThrow(
      'ollamaModel("qwen"): model.temperature must be a number from 0 up, got -1',
    );
    expect(() => ollamaModel("qwen", { topP: 2 })).toThrow('ollamaModel("qwen"): model.topP must be a number above 0 and at most 1, got 2');
  });

  test("a capacity that isn't a whole number from 1 up stops the start", () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      expect(() => ollamaModel("qwen", { capacity })).toThrow(
        `ollamaModel("qwen"): capacity must be a whole number from 1 up, got ${capacity}`,
      );
    }
  });
});

describe("ollamaModel: backgroundSlots", () => {
  test("as declared below the capacity; 1 when left out or empty", () => {
    expect(ollamaModel("gemma", { capacity: 8, backgroundSlots: 2 }).backgroundSlots).toBe(2);
    expect(ollamaModel("gemma", { capacity: 8, backgroundSlots: undefined }).backgroundSlots).toBe(1);
  });

  test("not a whole number from 1 up, not below a capacity above 1, or not 1 with capacity 1: the start stops", () => {
    expect(() => ollamaModel("gemma", { capacity: 8, backgroundSlots: 0 })).toThrow(
      'ollamaModel("gemma"): backgroundSlots must be a whole number from 1 up, got 0',
    );
    expect(() => ollamaModel("gemma", { capacity: 8, backgroundSlots: 1.5 })).toThrow(
      'ollamaModel("gemma"): backgroundSlots must be a whole number from 1 up, got 1.5',
    );
    expect(() => ollamaModel("gemma", { capacity: 4, backgroundSlots: 4 })).toThrow(
      'ollamaModel("gemma"): backgroundSlots must be below capacity (4), got 4',
    );
    expect(() => ollamaModel("qwen", { backgroundSlots: 2 })).toThrow('ollamaModel("qwen"): backgroundSlots must be 1 with capacity 1, got 2');
  });
});

describe("ollamaEmbedding", () => {
  test("a handle with its name, capacity 1 when left out", () => {
    expect(ollamaEmbedding("nomic-embed-text")).toEqual({
      provider: "ollama",
      kind: "embedding",
      name: "nomic-embed-text",
      capacity: 1,
    });
    expect(Object.isFrozen(ollamaEmbedding("nomic-embed-text"))).toBe(true);
  });

  test("capacity as declared", () => {
    expect(ollamaEmbedding("nomic-embed-text", { capacity: 4 }).capacity).toBe(4);
  });

  test("an empty name or a bad capacity stops the start", () => {
    expect(() => ollamaEmbedding("")).toThrow(
      "ollamaEmbedding needs the model's name and got none: is the variable it's read from set?",
    );
    expect(() => ollamaEmbedding("e", { capacity: 0 })).toThrow('ollamaEmbedding("e"): capacity must be a whole number from 1 up, got 0');
  });
});

describe("resolveModels", () => {
  test("background left out: the turn's model, built once", () => {
    const { provider, built } = fakeProvider();
    const turn = ollamaModel("qwen", { temperature: 0.2 });
    const models = resolveModels({ turn }, provider);
    expect(models.background).toBe(models.turn);
    expect(built).toEqual([{ kind: "language", name: "qwen", settings: { think: true, options: { temperature: 0.2 } } }]);
    expect(models.embedding).toBeUndefined();
  });

  test("a background model of its own, and the embedding model", () => {
    const { provider, built } = fakeProvider();
    const models = resolveModels(
      { turn: ollamaModel("big"), background: ollamaModel("small", { think: false }), embedding: ollamaEmbedding("nomic") },
      provider,
    );
    expect(models.background).not.toBe(models.turn);
    expect(built).toEqual([
      { kind: "language", name: "big", settings: { think: true } },
      { kind: "language", name: "small", settings: { think: false } },
      { kind: "embedding", name: "nomic" },
    ]);
  });

  test("the same handle in two roles is one model", () => {
    const { provider, built } = fakeProvider();
    const main = ollamaModel("qwen");
    const models = resolveModels({ turn: main, background: main }, provider);
    expect(models.background).toBe(models.turn);
    expect(built).toHaveLength(1);
  });

  test("modelFor: a role's handle gives that role's model; a plugin's own handle is built once, on first ask", () => {
    const { provider, built } = fakeProvider();
    const main = ollamaModel("qwen");
    const writer = ollamaModel("query-writer", { capacity: 4 });
    const models = resolveModels({ turn: main }, provider);
    expect(models.modelFor(main)).toBe(models.turn);
    expect(built).toHaveLength(1);
    const first = models.modelFor(writer);
    expect(models.modelFor(writer)).toBe(first);
    expect(built).toEqual([
      { kind: "language", name: "qwen", settings: { think: true } },
      { kind: "language", name: "query-writer", settings: { think: true } },
    ]);
  });

  test("two handles with the same name are two models: identity is the object", () => {
    const { provider, built } = fakeProvider();
    const models = resolveModels({ turn: ollamaModel("qwen"), background: ollamaModel("qwen", { think: false }) }, provider);
    expect(models.background).not.toBe(models.turn);
    expect(built).toHaveLength(2);
  });

  test("the roles as the startup reports them: name and capacity of each declared one", () => {
    const { provider } = fakeProvider();
    const main = ollamaModel("qwen", { capacity: 1 });
    expect(resolveModels({ turn: main }, provider).report).toEqual({
      turn: { name: "qwen", capacity: 1 },
      background: { name: "qwen", capacity: 1 },
    });
    expect(
      resolveModels({ turn: main, background: ollamaModel("small", { capacity: 4 }), embedding: ollamaEmbedding("nomic") }, provider).report,
    ).toEqual({
      turn: { name: "qwen", capacity: 1 },
      background: { name: "small", capacity: 4 },
      embedding: { name: "nomic", capacity: 1 },
    });
  });

  test("the startup lines: each role with its settings and capacity, background on turn said so", () => {
    const { provider } = fakeProvider();
    expect(resolveModels({ turn: ollamaModel("qwen", { temperature: 0.2 }) }, provider).describe()).toEqual([
      "[model] turn qwen: think on, temperature 0.2, capacity 1",
      "[model] background: the turn's model",
    ]);
    expect(
      resolveModels(
        { turn: ollamaModel("big", { capacity: 8 }), background: ollamaModel("small", { think: false }), embedding: ollamaEmbedding("nomic") },
        provider,
      ).describe(),
    ).toEqual([
      "[model] turn big: think on, server defaults, capacity 8",
      "[model] background small: think off, server defaults, capacity 1",
      "[model] embedding nomic: capacity 1",
    ]);
  });
});
