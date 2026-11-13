/**
 * What a model answered, cleaned into a conversation's title: the store keeps
 * a title of at most `MAX_TITLE_LENGTH` characters on one line.
 */

/** The longest a title can be, in characters (the core refuses a longer one a person chooses). */
export const MAX_TITLE_LENGTH = 100;

/** Pairs of quotes a model wraps a title in. */
const WRAPPING_QUOTES: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
  ["`", "`"],
];

/** Strips one pair of quotes wrapped around `text`, if any. */
function unwrapQuotes(text: string): string {
  for (const [open, close] of WRAPPING_QUOTES) {
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

/**
 * What a model answered, as a title: its first non-empty line without the
 * dressing a model adds (a `Title:` label, Markdown marks, wrapping quotes, a
 * trailing period or colon, control characters), cut on a word boundary with
 * an ellipsis when longer than `MAX_TITLE_LENGTH`. Empty when nothing is left.
 */
export function cleanGeneratedTitle(raw: string): string {
  const line = raw.split(/\r?\n|[\u0085\u2028\u2029]/).find((l) => l.trim() !== "") ?? "";
  let text = line.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  text = text.replace(/^#+\s+/, "").replace(/^(title|titolo)\s*:\s*/i, "");
  text = text.replace(/\*\*|__|\*|`/g, "").trim();
  let previous: string;
  do {
    previous = text;
    text = unwrapQuotes(text);
  } while (text !== previous);
  text = text.replace(/[.:]+$/, "").trim();
  if (text.length <= MAX_TITLE_LENGTH) return text;
  const room = text.slice(0, MAX_TITLE_LENGTH - 1);
  const lastSpace = room.lastIndexOf(" ");
  const cut = lastSpace > 0 ? room.slice(0, lastSpace) : room;
  return `${cut.trimEnd()}…`;
}

