/**
 * The checks on a context layer's knobs (#387): whether a plugin's `KnobSpec`
 * holds together (the plugin loader leaves out a plugin whose spec doesn't),
 * and whether a value fits a spec (what an admin sets, what a settings file
 * kept).
 *
 * Used by: `plugin-loader.ts` (the specs) and `context-settings.ts` (the values).
 */
import type { KnobSpec } from "@mercury-fw/plugin-types";

const TYPES = new Set(["boolean", "integer", "number", "string", "enum"]);

/** Why `value` doesn't fit `spec`, worded to follow the knob's name; `undefined` when it fits. */
export function knobValueError(spec: KnobSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be a boolean";
    case "string":
      return typeof value === "string" ? undefined : "must be a string";
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? undefined : `must be one of ${spec.values.join(", ")}`;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (spec.type === "integer" && !Number.isInteger(value)) return "must be a whole number";
      if (spec.min !== undefined && value < spec.min) return `must be ${spec.min} or more`;
      if (spec.max !== undefined && value > spec.max) return `must be ${spec.max} or less`;
      return undefined;
  }
}

/** Why `spec` doesn't hold together; `undefined` when it does. */
export function knobSpecError(spec: KnobSpec): string | undefined {
  if (!TYPES.has(spec.type)) return `"${spec.type}" isn't a knob type`;
  if (typeof spec.description !== "string" || spec.description.trim() === "") return "it has no description";
  if (spec.type === "enum" && (!Array.isArray(spec.values) || spec.values.length === 0)) return "an enum needs values";
  if ((spec.type === "integer" || spec.type === "number") && spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
    return `its min ${spec.min} is above its max ${spec.max}`;
  }
  const error = knobValueError(spec, spec.default);
  if (error === undefined) return undefined;
  switch (spec.type) {
    case "boolean":
      return "its default isn't a boolean";
    case "string":
      return "its default isn't a string";
    case "enum":
      return `its default ${JSON.stringify(spec.default)} isn't among its values`;
    default: {
      const value = spec.default as unknown;
      if (typeof value !== "number" || !Number.isFinite(value)) return "its default isn't a number";
      if (spec.type === "integer" && !Number.isInteger(value)) return `its default ${value} isn't a whole number`;
      if (spec.min !== undefined && value < spec.min) return `its default ${value} is below its min ${spec.min}`;
      return `its default ${value} is above its max ${spec.max}`;
    }
  }
}
