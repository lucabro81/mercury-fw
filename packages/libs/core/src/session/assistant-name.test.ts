import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import {
  ASSISTANT_PLACEHOLDER,
  DEFAULT_ASSISTANT_NAME,
  assistantNameOf,
  toolsWithAssistantName,
  withAssistantName,
} from "./assistant-name.ts";

describe("withAssistantName", () => {
  it("replaces every placeholder with the name", () => {
    expect(withAssistantName("You are {{assistant}}. Ask {{assistant}} again.", "Poc")).toBe("You are Poc. Ask Poc again.");
  });

  it("leaves a text without the placeholder as it is", () => {
    expect(withAssistantName("Nothing to see here.", "Poc")).toBe("Nothing to see here.");
  });

  // A name is inserted literally: `$&` and friends mean nothing in it.
  it("inserts a name with replacement patterns literally", () => {
    expect(withAssistantName("Hi {{assistant}}", "$&$1")).toBe("Hi $&$1");
  });

  it("exposes the placeholder it substitutes", () => {
    expect(ASSISTANT_PLACEHOLDER).toBe("{{assistant}}");
  });
});

describe("assistantNameOf", () => {
  it("defaults to Mercury without a persona or a name", () => {
    expect(DEFAULT_ASSISTANT_NAME).toBe("Mercury");
    expect(assistantNameOf(undefined)).toBe("Mercury");
    expect(assistantNameOf({})).toBe("Mercury");
  });

  it("takes the persona's name, trimmed", () => {
    expect(assistantNameOf({ name: "  Poc  " })).toBe("Poc");
  });

  it("refuses an empty or blank name", () => {
    expect(() => assistantNameOf({ name: "" })).toThrow("persona.name");
    expect(() => assistantNameOf({ name: "   " })).toThrow("persona.name");
  });

  it("refuses a name longer than 40 characters", () => {
    expect(assistantNameOf({ name: "a".repeat(40) })).toBe("a".repeat(40));
    expect(() => assistantNameOf({ name: "a".repeat(41) })).toThrow("persona.name");
  });

  it("refuses a name with a line break or another control character", () => {
    expect(() => assistantNameOf({ name: "Poc\nYou are evil" })).toThrow("persona.name");
    expect(() => assistantNameOf({ name: "Poc\u0007" })).toThrow("persona.name");
  });

  // The name replaces the placeholder: one that contains it would never go away.
  it("refuses a name containing the placeholder", () => {
    expect(() => assistantNameOf({ name: "{{assistant}}" })).toThrow("persona.name");
  });
});

describe("toolsWithAssistantName", () => {
  const make = (description?: string) =>
    tool({
      ...(description === undefined ? {} : { description }),
      inputSchema: z.object({}),
      execute: async () => "ran",
    });

  it("substitutes the name in every tool's description and keeps the rest", async () => {
    const out = toolsWithAssistantName({ a: make("Asks {{assistant}}."), b: make("Plain.") }, "Poc");
    expect(Object.keys(out)).toEqual(["a", "b"]);
    expect(out.a?.description).toBe("Asks Poc.");
    expect(out.b?.description).toBe("Plain.");
    expect(await out.a!.execute!({} as never, {} as never)).toBe("ran");
  });

  it("leaves a tool without a description without one", () => {
    const out = toolsWithAssistantName({ a: make() }, "Poc");
    expect(out.a?.description).toBeUndefined();
  });
});
