/**
 * The home page's title drawn in characters: a field of source code, read in
 * order, in which the cells a text mask marks (src/lib/text-mask.ts) are the
 * letters, and a few other cells are picked to stand out.
 */

/** One character of the field: part of a letter, picked to stand out, or neither. */
export interface Cell {
  ch: string;
  kind: "off" | "on" | "bright";
}

export interface CharFieldOptions {
  /** Returns a number in [0, 1), as Math.random does. */
  random: () => number;
  /** The share of the cells outside the letters to brighten. */
  brightShare: number;
}

/** Source code as one line: block comments (JSDoc included) dropped, whitespace collapsed. */
export function codeText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fills the mask's grid with the text, in order and starting over when it runs
 * out. A space inside a letter becomes a middle dot, so the letter has no
 * holes; outside the letters, `brightShare` of the non-space cells stand out.
 */
export function charField(mask: boolean[][], text: string, options: CharFieldOptions): Cell[][] {
  if (!text) throw new Error("The field's text is empty");
  const { random, brightShare } = options;
  let next = 0;
  return mask.map((row) =>
    row.map((on) => {
      const ch = text[next++ % text.length];
      if (on) return { ch: ch === " " ? "·" : ch, kind: "on" };
      return { ch, kind: ch !== " " && random() < brightShare ? "bright" : "off" };
    }),
  );
}
