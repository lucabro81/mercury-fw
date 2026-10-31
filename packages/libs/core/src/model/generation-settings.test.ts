/**
 * Tests for the main model's generation settings (#355): the config's `model`
 * section turned into what `ai-sdk-ollama` takes, and the startup line. What
 * isn't set must not reach Ollama at all, so the model's own values (its
 * Modelfile) apply and an instance that sets nothing behaves as before.
 */
import { describe, expect, test } from "bun:test";
import { describeModelSettings, ollamaSettings } from "./generation-settings.ts";

describe("ollamaSettings", () => {
  test("no section: think on, no options at all", () => {
    expect(ollamaSettings(undefined)).toEqual({ think: true });
    expect(Object.keys(ollamaSettings(undefined))).toEqual(["think"]);
  });

  test("entries left undefined (empty variables) send nothing to Ollama", () => {
    const settings = ollamaSettings({ think: undefined, temperature: undefined, topP: undefined, topK: undefined });
    expect(settings).toEqual({ think: true });
    expect(Object.keys(settings)).toEqual(["think"]);
  });

  test("think false", () => {
    expect(ollamaSettings({ think: false })).toEqual({ think: false });
  });

  test("each entry alone, under Ollama's own option name", () => {
    expect(ollamaSettings({ temperature: 0.2 })).toEqual({ think: true, options: { temperature: 0.2 } });
    expect(ollamaSettings({ topP: 0.8 })).toEqual({ think: true, options: { top_p: 0.8 } });
    expect(ollamaSettings({ topK: 20 })).toEqual({ think: true, options: { top_k: 20 } });
  });

  test("only the entries set reach the options, never an undefined key", () => {
    const settings = ollamaSettings({ temperature: 0.2, topP: undefined, topK: 20 });
    expect(settings).toEqual({ think: true, options: { temperature: 0.2, top_k: 20 } });
    expect(Object.keys(settings.options ?? {})).toEqual(["temperature", "top_k"]);
  });

  test("all together", () => {
    expect(ollamaSettings({ think: false, temperature: 0, topP: 1, topK: 1 })).toEqual({
      think: false,
      options: { temperature: 0, top_p: 1, top_k: 1 },
    });
  });

  test("a value out of its range stops the start, naming the entry", () => {
    expect(() => ollamaSettings({ temperature: -1 })).toThrow("model.temperature must be a number from 0 up, got -1");
    expect(() => ollamaSettings({ temperature: Number.NaN })).toThrow("model.temperature must be a number from 0 up, got NaN");
    expect(() => ollamaSettings({ topP: 0 })).toThrow("model.topP must be a number above 0 and at most 1, got 0");
    expect(() => ollamaSettings({ topP: 1.5 })).toThrow("model.topP must be a number above 0 and at most 1, got 1.5");
    expect(() => ollamaSettings({ topK: 2.5 })).toThrow("model.topK must be a whole number from 1 up, got 2.5");
    expect(() => ollamaSettings({ topK: 0 })).toThrow("model.topK must be a whole number from 1 up, got 0");
  });
});

describe("describeModelSettings", () => {
  test("nothing set: the server's defaults", () => {
    expect(describeModelSettings("qwen3.8:27b", ollamaSettings(undefined))).toBe("[model] qwen3.8:27b: think on, server defaults");
  });

  test("think off, nothing else", () => {
    expect(describeModelSettings("gemma4:12b", ollamaSettings({ think: false }))).toBe("[model] gemma4:12b: think off, server defaults");
  });

  test("the settings that are set, in a fixed order", () => {
    expect(describeModelSettings("qwen3.8:27b", ollamaSettings({ topK: 20, temperature: 0.2 }))).toBe(
      "[model] qwen3.8:27b: think on, temperature 0.2, top_k 20",
    );
    expect(describeModelSettings("qwen3.8:27b", ollamaSettings({ think: false, temperature: 0.2, topP: 0.8, topK: 20 }))).toBe(
      "[model] qwen3.8:27b: think off, temperature 0.2, top_p 0.8, top_k 20",
    );
  });
});
