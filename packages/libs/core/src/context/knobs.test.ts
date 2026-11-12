import { describe, expect, test } from "bun:test";
import type { KnobSpec } from "@mercury-fw/plugin-types";
import { knobSpecError, knobValueError } from "./knobs.ts";

describe("knobSpecError", () => {
  test("accepts a spec whose default fits it", () => {
    const specs: KnobSpec[] = [
      { type: "boolean", default: true, description: "d" },
      { type: "integer", default: 3, description: "d", min: 1, max: 5 },
      { type: "number", default: 0.5, description: "d", min: 0, max: 1 },
      { type: "string", default: "", description: "d" },
      { type: "enum", default: "a", description: "d", values: ["a", "b"] },
    ];
    for (const spec of specs) expect(knobSpecError(spec)).toBeUndefined();
  });

  test("refuses a spec whose default is outside it", () => {
    expect(knobSpecError({ type: "integer", default: 1.5, description: "d" })).toBe("its default 1.5 isn't a whole number");
    expect(knobSpecError({ type: "integer", default: 0, description: "d", min: 1 })).toBe("its default 0 is below its min 1");
    expect(knobSpecError({ type: "number", default: 2, description: "d", max: 1 })).toBe("its default 2 is above its max 1");
    expect(knobSpecError({ type: "enum", default: "c", description: "d", values: ["a", "b"] })).toBe('its default "c" isn\'t among its values');
    expect(knobSpecError({ type: "boolean", default: "yes", description: "d" } as unknown as KnobSpec)).toBe("its default isn't a boolean");
  });

  test("refuses a spec that contradicts itself or isn't one", () => {
    expect(knobSpecError({ type: "enum", default: "a", description: "d", values: [] })).toBe("an enum needs values");
    expect(knobSpecError({ type: "integer", default: 3, description: "d", min: 5, max: 1 })).toBe("its min 5 is above its max 1");
    expect(knobSpecError({ type: "date", default: "x", description: "d" } as unknown as KnobSpec)).toBe('"date" isn\'t a knob type');
    expect(knobSpecError({ type: "boolean", default: true } as unknown as KnobSpec)).toBe("it has no description");
  });
});

describe("knobValueError", () => {
  test("accepts a value the spec allows", () => {
    expect(knobValueError({ type: "boolean", default: true, description: "d" }, false)).toBeUndefined();
    expect(knobValueError({ type: "integer", default: 3, description: "d", min: 1, max: 5 }, 5)).toBeUndefined();
    expect(knobValueError({ type: "number", default: 0.5, description: "d", min: 0, max: 1 }, 0)).toBeUndefined();
    expect(knobValueError({ type: "string", default: "", description: "d" }, "anything")).toBeUndefined();
    expect(knobValueError({ type: "enum", default: "a", description: "d", values: ["a", "b"] }, "b")).toBeUndefined();
  });

  test("refuses a value of another type, out of bounds, or not listed", () => {
    expect(knobValueError({ type: "boolean", default: true, description: "d" }, "true")).toBe("must be a boolean");
    expect(knobValueError({ type: "integer", default: 3, description: "d" }, 2.5)).toBe("must be a whole number");
    expect(knobValueError({ type: "integer", default: 3, description: "d", min: 1 }, 0)).toBe("must be 1 or more");
    expect(knobValueError({ type: "number", default: 0.5, description: "d", max: 1 }, 1.1)).toBe("must be 1 or less");
    expect(knobValueError({ type: "number", default: 0.5, description: "d" }, Number.NaN)).toBe("must be a number");
    expect(knobValueError({ type: "string", default: "", description: "d" }, 3)).toBe("must be a string");
    expect(knobValueError({ type: "enum", default: "a", description: "d", values: ["a", "b"] }, "c")).toBe("must be one of a, b");
    expect(knobValueError({ type: "enum", default: "a", description: "d", values: ["a", "b"] }, null)).toBe("must be one of a, b");
  });
});
