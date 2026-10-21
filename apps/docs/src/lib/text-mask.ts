/**
 * Which cells of a grid of monospace characters fall inside some text set in a
 * real font: the font's outlines (read with opentype.js at build time) are
 * flattened into polygons and each cell's center is tested against them.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse, type Font, type PathCommand } from "opentype.js";

export interface Point {
  x: number;
  y: number;
}

/** Points each curve is cut into when flattened. */
const CURVE_STEPS = 8;

/** Loads a font file from an installed package, e.g. a @fontsource WOFF. */
export function loadFont(specifier: string): Font {
  const file = createRequire(`${process.cwd()}/package.json`).resolve(specifier);
  const bytes = readFileSync(file);
  return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** A path's commands as polygons, one per subpath, curves cut into straight segments. */
export function flattenPath(commands: PathCommand[]): Point[][] {
  const polygons: Point[][] = [];
  let current: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  const close = () => {
    if (current.length > 2) polygons.push(current);
    current = [];
  };
  for (const cmd of commands) {
    if (cmd.type === "M") {
      close();
      at = { x: cmd.x, y: cmd.y };
      current.push(at);
    } else if (cmd.type === "L") {
      at = { x: cmd.x, y: cmd.y };
      current.push(at);
    } else if (cmd.type === "Q") {
      const from = at;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        current.push({
          x: u * u * from.x + 2 * u * t * cmd.x1 + t * t * cmd.x,
          y: u * u * from.y + 2 * u * t * cmd.y1 + t * t * cmd.y,
        });
      }
      at = { x: cmd.x, y: cmd.y };
    } else if (cmd.type === "C") {
      const from = at;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        current.push({
          x: u * u * u * from.x + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
          y: u * u * u * from.y + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
        });
      }
      at = { x: cmd.x, y: cmd.y };
    } else if (cmd.type === "Z") {
      close();
    }
  }
  close();
  return polygons;
}

/** Whether a point is inside the polygons by the nonzero winding rule, the one fonts use. */
export function insidePath(polygons: Point[][], x: number, y: number): boolean {
  let winding = 0;
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (a.y <= y && b.y > y && side > 0) winding++;
      else if (a.y > y && b.y <= y && side < 0) winding--;
    }
  }
  return winding !== 0;
}

export interface TextMaskOptions {
  /** Width of the grid, in cells. */
  cols: number;
  /** Blank space around the text, in em, on every side. */
  margin: number;
  /** Blank space between two lines, in em. */
  lineGap: number;
}

/**
 * The grid of cells, `cols` wide, with `true` where a cell's center falls
 * inside the text. Each line is centered on the widest; a cell is twice as tall
 * as it is wide, as a monospace character in its line is.
 */
export function textMask(font: Font, lines: string[], options: TextMaskOptions): boolean[][] {
  const em = font.unitsPerEm;
  const { cols, margin, lineGap } = options;
  const advances = lines.map((line) => font.getAdvanceWidth(line, em));
  const widest = Math.max(...advances);

  // Lines stacked on their ink, top to bottom, in font units with y down.
  let top = margin * em;
  const placed = lines.map((line, i) => {
    const x = margin * em + (widest - advances[i]) / 2;
    const box = font.getPath(line, 0, 0, em).getBoundingBox();
    const baseline = top - box.y1;
    top += box.y2 - box.y1 + lineGap * em;
    return flattenPath(font.getPath(line, x, baseline, em).commands);
  });
  const height = top - lineGap * em + margin * em;

  const cellWidth = (widest + 2 * margin * em) / cols;
  const cellHeight = 2 * cellWidth;
  const rows = Math.ceil(height / cellHeight);
  const polygons = placed.flat();
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => insidePath(polygons, (c + 0.5) * cellWidth, (r + 0.5) * cellHeight)),
  );
}

/** The mask with `cols` blank columns added on each side, to widen the field past the text. */
export function padMask(mask: boolean[][], cols: number): boolean[][] {
  const blank = Array<boolean>(cols).fill(false);
  return mask.map((row) => [...blank, ...row, ...blank]);
}
