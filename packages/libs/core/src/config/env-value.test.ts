/**
 * Tests for the helpers a `mercury.config.ts` reads a setting's value from the
 * environment with (#355): unset or empty gives the fallback, anything that
 * isn't the expected kind of value stops the start naming the variable.
 */
import { describe, expect, test } from "bun:test";
import { envBoolean, envNumber } from "./env-value.ts";

describe("envNumber", () => {
  test("an unset variable gives the fallback, undefined when there is none", () => {
    expect(envNumber("OLLAMA_TEMPERATURE", undefined, {})).toBeUndefined();
    expect(envNumber("OLLAMA_TEMPERATURE", 0.2, {})).toBe(0.2);
  });

  test("an empty or blank variable gives the fallback", () => {
    expect(envNumber("OLLAMA_TEMPERATURE", undefined, { OLLAMA_TEMPERATURE: "" })).toBeUndefined();
    expect(envNumber("OLLAMA_TEMPERATURE", 0.7, { OLLAMA_TEMPERATURE: "   " })).toBe(0.7);
  });

  test("a number, whole or decimal, with spaces around it", () => {
    expect(envNumber("OLLAMA_TEMPERATURE", undefined, { OLLAMA_TEMPERATURE: "0.2" })).toBe(0.2);
    expect(envNumber("OLLAMA_TOP_K", undefined, { OLLAMA_TOP_K: " 40 " })).toBe(40);
    expect(envNumber("OLLAMA_TEMPERATURE", undefined, { OLLAMA_TEMPERATURE: ".5" })).toBe(0.5);
    expect(envNumber("OLLAMA_TEMPERATURE", 0.2, { OLLAMA_TEMPERATURE: "0" })).toBe(0);
  });

  test("a negative number is still a number: the range is the setting's to check", () => {
    expect(envNumber("OLLAMA_TEMPERATURE", undefined, { OLLAMA_TEMPERATURE: "-1" })).toBe(-1);
  });

  test("text that isn't a number throws, naming the variable and the value", () => {
    expect(() => envNumber("OLLAMA_TEMPERATURE", undefined, { OLLAMA_TEMPERATURE: "abc" })).toThrow(
      'OLLAMA_TEMPERATURE must be a number, got "abc"',
    );
    expect(() => envNumber("OLLAMA_TOP_P", undefined, { OLLAMA_TOP_P: "0,9" })).toThrow('OLLAMA_TOP_P must be a number, got "0,9"');
    expect(() => envNumber("OLLAMA_TOP_K", undefined, { OLLAMA_TOP_K: "Infinity" })).toThrow('OLLAMA_TOP_K must be a number, got "Infinity"');
    expect(() => envNumber("OLLAMA_TOP_K", undefined, { OLLAMA_TOP_K: "0x10" })).toThrow('OLLAMA_TOP_K must be a number, got "0x10"');
  });

  test("reads process.env when no environment is given", () => {
    process.env.MERCURY_TEST_ENV_NUMBER = "1.5";
    try {
      expect(envNumber("MERCURY_TEST_ENV_NUMBER")).toBe(1.5);
    } finally {
      delete process.env.MERCURY_TEST_ENV_NUMBER;
    }
  });
});

describe("envBoolean", () => {
  test("an unset, empty or blank variable gives the fallback", () => {
    expect(envBoolean("OLLAMA_THINK", true, {})).toBe(true);
    expect(envBoolean("OLLAMA_THINK", false, { OLLAMA_THINK: "" })).toBe(false);
    expect(envBoolean("OLLAMA_THINK", true, { OLLAMA_THINK: "  " })).toBe(true);
  });

  test("true and false, with spaces around them", () => {
    expect(envBoolean("OLLAMA_THINK", true, { OLLAMA_THINK: "false" })).toBe(false);
    expect(envBoolean("OLLAMA_THINK", false, { OLLAMA_THINK: " true " })).toBe(true);
  });

  test("anything else throws, naming the variable and the value", () => {
    expect(() => envBoolean("OLLAMA_THINK", true, { OLLAMA_THINK: "yes" })).toThrow('OLLAMA_THINK must be true or false, got "yes"');
    expect(() => envBoolean("OLLAMA_THINK", true, { OLLAMA_THINK: "0" })).toThrow('OLLAMA_THINK must be true or false, got "0"');
    expect(() => envBoolean("OLLAMA_THINK", true, { OLLAMA_THINK: "False" })).toThrow('OLLAMA_THINK must be true or false, got "False"');
  });

  test("reads process.env when no environment is given", () => {
    process.env.MERCURY_TEST_ENV_BOOLEAN = "false";
    try {
      expect(envBoolean("MERCURY_TEST_ENV_BOOLEAN", true)).toBe(false);
    } finally {
      delete process.env.MERCURY_TEST_ENV_BOOLEAN;
    }
  });
});
