/**
 * Tests for the composition config helper. `defineMercuryConfig` is a pure
 * identity+typing helper — it must hand back exactly what it was given, adding
 * no runtime behavior. Which plugins an app declares is that app's business,
 * tested there if anywhere: the core is agnostic to what any app composes.
 */
import { describe, expect, test } from "bun:test";
import { defineMercuryConfig } from "./define-config.ts";

describe("defineMercuryConfig", () => {
  test("returns its input unchanged (same reference)", () => {
    const input = { plugins: [] };
    expect(defineMercuryConfig(input)).toBe(input);
  });

  test("carries the declared plugins through verbatim", () => {
    const a = { apiVersion: 1, name: "a", description: "A.", cliConfig: {} };
    const b = { apiVersion: 1, name: "b", description: "B.", cliConfig: {} };
    const config = defineMercuryConfig({ plugins: [a, b] });
    expect(config.plugins).toEqual([a, b]);
  });

  test("carries the persona through verbatim", () => {
    const persona = { identity: "You are Hermes.", tone: "Be terse." };
    expect(defineMercuryConfig({ plugins: [], persona }).persona).toBe(persona);
  });
});
