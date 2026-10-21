import { describe, expect, test } from "bun:test";
import { flattenPath, insidePath, loadFont, padMask, textMask } from "./text-mask.ts";

const font = loadFont("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff");

/** A mask as strings, "#" on and "." off, to read a shape in a failure message. */
const show = (mask: boolean[][]) => mask.map((row) => row.map((on) => (on ? "#" : ".")).join(""));

describe("flattenPath", () => {
  test("turns each closed subpath into a polygon of its points", () => {
    const polygons = flattenPath([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "L", x: 10, y: 10 },
      { type: "Z" },
      { type: "M", x: 20, y: 20 },
      { type: "L", x: 30, y: 20 },
      { type: "L", x: 30, y: 30 },
      { type: "Z" },
    ]);
    expect(polygons).toEqual([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }],
    ]);
  });

  test("follows a curve through points on it, ending on its end point", () => {
    const [polygon] = flattenPath([
      { type: "M", x: 0, y: 0 },
      { type: "Q", x1: 10, y1: 10, x: 20, y: 0 },
      { type: "C", x1: 20, y1: -10, x2: 0, y2: -10, x: 0, y: 0 },
      { type: "Z" },
    ]);
    expect(polygon.length).toBeGreaterThan(8);
    // The quadratic's midpoint is halfway to its control point.
    expect(polygon).toContainEqual({ x: 10, y: 5 });
    expect(polygon.at(-1)).toEqual({ x: 0, y: 0 });
  });
});

describe("insidePath", () => {
  const square = (x: number, y: number, size: number, clockwise: boolean) => {
    const points = [
      { x, y },
      { x: x + size, y },
      { x: x + size, y: y + size },
      { x, y: y + size },
    ];
    return clockwise ? points : points.reverse();
  };

  test("tells points inside a polygon from points outside it", () => {
    const polygons = [square(0, 0, 10, true)];
    expect(insidePath(polygons, 5, 5)).toBe(true);
    expect(insidePath(polygons, 15, 5)).toBe(false);
    expect(insidePath(polygons, 5, -1)).toBe(false);
  });

  test("leaves a counter wound the other way empty, as a font's o is", () => {
    const polygons = [square(0, 0, 10, true), square(3, 3, 4, false)];
    expect(insidePath(polygons, 1, 1)).toBe(true);
    expect(insidePath(polygons, 5, 5)).toBe(false);
  });
});

describe("textMask", () => {
  test("is exactly cols wide, every row", () => {
    const mask = textMask(font, ["mercury", "framework"], { cols: 120, margin: 0.5, lineGap: 0.2 });
    expect(mask.every((row) => row.length === 120)).toBe(true);
    expect(mask.length).toBeGreaterThan(10);
  });

  test("draws an o as a ring, with its counter empty", () => {
    const mask = textMask(font, ["o"], { cols: 30, margin: 0.2, lineGap: 0 });
    const on = mask.flatMap((row, y) => row.flatMap((cell, x) => (cell ? [{ x, y }] : [])));
    const ys = on.map((p) => p.y);
    const xs = on.map((p) => p.x);
    const midY = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
    const midX = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
    expect(mask[midY][midX], show(mask).join("\n")).toBe(false);
    expect(mask[midY][Math.min(...xs)]).toBe(true);
    expect(mask[midY][Math.max(...xs)]).toBe(true);
  });

  test("keeps the margin, in em, blank on both sides of the widest line", () => {
    // One em of margin each side of a one-character line (0.6em wide): 2.6em in all.
    const mask = textMask(font, ["o"], { cols: 26, margin: 1, lineGap: 0 });
    const columnsUsed = mask[0].map((_, x) => mask.some((row) => row[x]));
    expect(columnsUsed.slice(0, 10).some(Boolean)).toBe(false);
    expect(columnsUsed.slice(16).some(Boolean)).toBe(false);
  });

  test("centers a shorter line under a longer one", () => {
    const mask = textMask(font, ["ooo", "o"], { cols: 60, margin: 0, lineGap: 0.2 });
    const half = Math.floor(mask.length / 2);
    const columns = (rows: boolean[][]) =>
      mask[0].map((_, x) => x).filter((x) => rows.some((row) => row[x]));
    const bottom = columns(mask.slice(half));
    const left = bottom[0];
    const right = 59 - bottom.at(-1)!;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    expect(left).toBeGreaterThan(15);
  });

  test("makes cells twice as tall as wide, as a monospace character in its line is", () => {
    // An o is about as tall as it's wide, so it spans about half as many rows as columns.
    const mask = textMask(font, ["o"], { cols: 40, margin: 0, lineGap: 0 });
    const rows = mask.filter((row) => row.some(Boolean)).length;
    const cols = mask[0].filter((_, x) => mask.some((row) => row[x])).length;
    expect(rows / cols).toBeGreaterThan(0.4);
    expect(rows / cols).toBeLessThan(0.65);
  });
});

describe("padMask", () => {
  test("adds the given blank columns on each side of every row", () => {
    expect(
      padMask(
        [
          [true, false],
          [false, true],
        ],
        2,
      ),
    ).toEqual([
      [false, false, true, false, false, false],
      [false, false, false, true, false, false],
    ]);
  });

  test("leaves a mask unchanged with no columns to add", () => {
    expect(padMask([[true]], 0)).toEqual([[true]]);
  });
});
