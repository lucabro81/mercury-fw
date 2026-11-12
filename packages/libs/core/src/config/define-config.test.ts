/**
 * Tests for the composition config helper. `defineMercuryConfig` is a pure
 * identity+typing helper — it must hand back exactly what it was given, adding
 * no runtime behavior. Which plugins an app declares is that app's business,
 * tested there if anywhere: the core is agnostic to what any app composes.
 */
import { describe, expect, test } from "bun:test";
import { defineMercuryConfig } from "./define-config.ts";
import { ollamaModel } from "../model/models.ts";

const models = { turn: ollamaModel("m") };

describe("defineMercuryConfig", () => {
  test("returns its input unchanged (same reference)", () => {
    const input = { plugins: [], models };
    expect(defineMercuryConfig(input)).toBe(input);
  });

  test("carries the declared plugins through verbatim", () => {
    const a = { apiVersion: 1, name: "a", description: "A.", cliConfig: {} };
    const b = { apiVersion: 1, name: "b", description: "B.", cliConfig: {} };
    const config = defineMercuryConfig({ plugins: [a, b], models });
    expect(config.plugins).toEqual([a, b]);
  });

  test("carries the persona through verbatim", () => {
    const persona = { identity: "You are Hermes.", tone: "Be terse." };
    expect(defineMercuryConfig({ plugins: [], models, persona }).persona).toBe(persona);
  });
});

describe("defineMercuryConfig: context (#387)", () => {
  const wiki = { apiVersion: 6, name: "wiki", description: "Keeps notes." };
  const profile = { layers: [wiki], budget: { maxChars: 4000 } };

  test("takes profiles with a default and an assign naming them", () => {
    const config = defineMercuryConfig({
      plugins: [wiki],
      models,
      context: { profiles: { default: profile, premium: profile }, assign: { premium: ["paid"] } },
    });
    expect(config.context?.assign).toEqual({ premium: ["paid"] });
  });

  test("a context without a default profile, or assigning one that doesn't exist, doesn't type", () => {
    defineMercuryConfig({
      plugins: [wiki],
      models,
      // @ts-expect-error: every context has a default profile
      context: { profiles: { premium: profile } },
    });
    defineMercuryConfig({
      plugins: [wiki],
      models,
      context: {
        profiles: { default: profile, premium: profile },
        // @ts-expect-error: assign names only the profiles there are
        assign: { premum: ["paid"] },
      },
    });
  });
});
