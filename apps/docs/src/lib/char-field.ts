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
  /** Rows added under the mask, thinning out going down until they're empty. */
  tailRows?: number;
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
 * Under the mask, `tailRows` rows go on with the text, none of them bright,
 * each cell kept with a chance falling row by row as (1 - (r + 1) / (tailRows + 1))²,
 * and blank otherwise.
 */
export function charField(mask: boolean[][], text: string, options: CharFieldOptions): Cell[][] {
  if (!text) throw new Error("The field's text is empty");
  const { random, brightShare, tailRows = 0 } = options;
  let next = 0;
  const field = mask.map((row) =>
    row.map((on): Cell => {
      const ch = text[next++ % text.length];
      if (on) return { ch: ch === " " ? "·" : ch, kind: "on" };
      return { ch, kind: ch !== " " && random() < brightShare ? "bright" : "off" };
    }),
  );
  const width = mask[0]?.length ?? 0;
  for (let r = 0; r < tailRows; r++) {
    const density = (1 - (r + 1) / (tailRows + 1)) ** 2;
    field.push(
      Array.from({ length: width }, (): Cell => {
        const ch = text[next++ % text.length];
        return { ch: random() < density ? ch : " ", kind: "off" };
      }),
    );
  }
  return field;
}
