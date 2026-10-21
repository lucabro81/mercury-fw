import { describe, expect, test } from "bun:test";
import { charField, codeText } from "./char-field.ts";

const kinds = (rows: { kind: string }[][]) =>
  rows.map((row) => row.map((c) => ({ off: ".", on: "#", bright: "*" })[c.kind]).join(""));
const text = (rows: { ch: string }[][]) => rows.map((row) => row.map((c) => c.ch).join(""));

describe("codeText", () => {
  test("drops block comments, JSDoc included, and collapses whitespace to single spaces", () => {
    const source = `/**\n * Builds it.\n */\nexport function build(a: number) {\n\treturn a  * 2; /* twice */\n}\n`;
    expect(codeText(source)).toBe("export function build(a: number) { return a * 2; }");
  });

  test("keeps line comments and strings as they are", () => {
    expect(codeText('const url = "http://x";  // see it')).toBe('const url = "http://x"; // see it');
  });
});

describe("charField", () => {
  const none = () => 1;

  test("reads the text in order, row after row, starting over when it runs out", () => {
    const mask = [
      [false, false, false],
      [false, false, false],
    ];
    expect(text(charField(mask, "abcd", { random: none, brightShare: 0 }))).toEqual(["abc", "dab"]);
  });

  test("marks the cells of the mask as on", () => {
    const mask = [
      [false, true, false],
      [true, true, true],
    ];
    expect(kinds(charField(mask, "abcdef", { random: none, brightShare: 0 }))).toEqual([".#.", "###"]);
  });

  test("shows a space inside a letter as a middle dot, so the letter stays solid", () => {
    const mask = [[true, false, true, true]];
    const [row] = charField(mask, "a  b", { random: none, brightShare: 0 });
    expect(row.map((c) => c.ch).join("")).toBe("a ·b");
  });

  test("brightens the off cells random picks, never a space and never a letter's cell", () => {
    const mask = [[false, false, true, false, false]];
    const [row] = charField(mask, "abc d", { random: () => 0, brightShare: 0.05 });
    expect(row.map((c) => c.kind).join(",")).toBe("bright,bright,on,off,bright");
  });

  test("brightens about brightShare of the off cells", () => {
    const mask = Array.from({ length: 50 }, () => Array(100).fill(false));
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const cells = charField(mask, "x", { random, brightShare: 0.02 }).flat();
    const share = cells.filter((c) => c.kind === "bright").length / cells.length;
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(0.03);
  });

  test("refuses an empty text, which would leave the field blank", () => {
    expect(() => charField([[false]], "", { random: none, brightShare: 0 })).toThrow(/empty/);
  });
});
