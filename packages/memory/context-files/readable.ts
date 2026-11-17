/**
 * How a tool's output is written to a file so the model can read it in
 * pieces and find things in it: a text as it is; anything else one line per
 * value, each with its path (`issues[41].key: X-42`), and a long string (one
 * with line breaks, or over `BLOCK_CHARS`) as a block of its own lines under
 * its path. JSON would put a page's whole text on one escaped line.
 *
 * Used by: `conversation.ts`, for the outputs it moves to files.
 */

/** How long a string without line breaks may be before it's written as a block. */
const BLOCK_CHARS = 200;

/** `value`'s lines, each under `path` (the empty path at the top). */
function linesOf(value: unknown, path: string): string[] {
  const label = path === "" ? "" : `${path}: `;
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && (value.includes("\n") || value.length > BLOCK_CHARS)) return path === "" ? [value] : [`${path}:`, value];
    return [`${label}${String(value)}`];
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [`${path}[${i}]`, v])
    : Object.entries(value).map(([k, v]) => [path === "" ? k : `${path}.${k}`, v]);
  if (entries.length === 0) return [`${label}${Array.isArray(value) ? "[]" : "{}"}`];
  return entries.flatMap(([p, v]) => (v === undefined ? [] : linesOf(v, p)));
}

/** `output` as its file holds it; see the module comment. */
export function readableText(output: unknown): string {
  return typeof output === "string" ? output : linesOf(output, "").join("\n");
}
