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

  test("adds tailRows rows under the mask, as wide as it, going on with the text, none of them bright", () => {
    const mask = [[false, true, false]];
    const rows = charField(mask, "abcdefgh", { random: () => 0, brightShare: 1, tailRows: 2 });
    expect(text(rows)).toEqual(["abc", "def", "gha"]);
    expect(kinds(rows)).toEqual(["*#*", "...", "..."]);
  });

  test("keeps a tail cell while random stays under the row's density, (1 - (r + 1) / (tailRows + 1))²", () => {
    // Densities for 2 tail rows: 4/9 ≈ 0.44, then 1/9 ≈ 0.11; 0.3 sits between them.
    const mask = [[false, false, false]];
    const rows = charField(mask, "abcdefghi", { random: () => 0.3, brightShare: 0, tailRows: 2 });
    expect(text(rows)).toEqual(["abc", "def", "   "]);
  });

  test("thins the tail out going down, to almost nothing on its last row", () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const tail = charField([Array(200).fill(false)], "x", { random, brightShare: 0, tailRows: 40 }).slice(1);
    const share = (rows: { ch: string }[][]) =>
      rows.flat().filter((c) => c.ch !== " ").length / rows.flat().length;
    expect(share(tail.slice(0, 10))).toBeGreaterThan(0.6);
    expect(share(tail.slice(15, 25))).toBeGreaterThan(share(tail.slice(30, 40)));
    expect(share(tail.slice(-1))).toBeLessThan(0.01);
  });

  test("adds no tail by default", () => {
    expect(charField([[false]], "a", { random: none, brightShare: 0 })).toHaveLength(1);
  });

  test("refuses an empty text, which would leave the field blank", () => {
    expect(() => charField([[false]], "", { random: none, brightShare: 0 })).toThrow(/empty/);
  });
});
