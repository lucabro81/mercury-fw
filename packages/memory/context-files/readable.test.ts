import { describe, expect, it } from "bun:test";
import { readableText } from "./readable.ts";

describe("readableText", () => {
  it("leaves a text as it is", () => {
    expect(readableText("line one\nline two")).toBe("line one\nline two");
  });

  // Regression (#414): a page's text inside a JSON output was written as one
  // escaped line of 20000 characters, so a file couldn't be read in pieces.
  it("writes a long text field as a block of its own lines, under its name", () => {
    const page = { ok: true, url: "https://en.wikipedia.org/wiki/Mars", title: "Mars", text: "Mars\n\nThe fourth planet.\nIts surface is red." };
    expect(readableText(page)).toBe(
      ["ok: true", "url: https://en.wikipedia.org/wiki/Mars", "title: Mars", "text:", "Mars", "", "The fourth planet.", "Its surface is red."].join("\n"),
    );
  });

  it("writes a string over 200 characters as a block even without line breaks", () => {
    const long = "x".repeat(201);
    expect(readableText({ summary: long, key: "X-1" })).toBe(`summary:\n${long}\nkey: X-1`);
    expect(readableText({ summary: "x".repeat(200) })).toBe(`summary: ${"x".repeat(200)}`);
  });

  it("writes a list one value per line, each with its path, so a key is found by searching it", () => {
    const list = { issues: [{ key: "X-1", summary: "Login fails", fields: { status: "Open", points: 3 } }, { key: "X-2", summary: "Slow page", fields: { status: "Done", points: null } }] };
    expect(readableText(list)).toBe(
      [
        "issues[0].key: X-1",
        "issues[0].summary: Login fails",
        "issues[0].fields.status: Open",
        "issues[0].fields.points: 3",
        "issues[1].key: X-2",
        "issues[1].summary: Slow page",
        "issues[1].fields.status: Done",
        "issues[1].fields.points: null",
      ].join("\n"),
    );
  });

  it("writes a list at the top by index, empty containers as such, and leaves out what's undefined", () => {
    expect(readableText([{ a: 1 }, "two", [], {}])).toBe(["[0].a: 1", "[1]: two", "[2]: []", "[3]: {}"].join("\n"));
    expect(readableText({ a: undefined, b: false })).toBe("b: false");
  });

  it("writes a number, a boolean or null as it reads", () => {
    expect(readableText(42)).toBe("42");
    expect(readableText(false)).toBe("false");
    expect(readableText(null)).toBe("null");
  });
});
