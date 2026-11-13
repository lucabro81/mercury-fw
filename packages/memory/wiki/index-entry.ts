/**
 * Deterministic index.md line management. Turns "this curated doc, with
 * this description" into the exact `[[wikilink]]` line format
 * `orphan-detector.ts`'s wikilink check recognizes — instead of trusting
 * the model to freely author (and correctly reproduce, on every edit) the
 * whole file's syntax by hand, which is what `write_index` used to do and
 * how a doc could end up with an index.md line that still isn't
 * recognized as a reference to it.
 */

/** Accepts any of "curated/x/y.md", "x/y.md", or "x/y" and normalizes to "x/y" — the form `[[wikilink]]`s use. */
export function normalizeIndexKey(path: string): string {
  let key = path.trim();
  if (key.startsWith("curated/")) {
    key = key.slice("curated/".length);
  }
  if (key.endsWith(".md")) {
    key = key.slice(0, -".md".length);
  }
  return key;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findEntryLine(lines: string[], key: string): number {
  const re = new RegExp(`\\[\\[${escapeRegExp(key)}(\\||\\])`);
  return lines.findIndex((line) => re.test(line));
}

function formatEntry(key: string, description: string): string {
  return `- [[${key}]] — ${description}`;
}

/** Adds a line for `key`, or replaces its existing one in place — never duplicates an entry. */
export function upsertIndexEntry(content: string, key: string, description: string): string {
  const lines = content.length > 0 ? content.split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === "")) : [];
  const newLine = formatEntry(key, description);

  const idx = findEntryLine(lines, key);
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }
  return `${lines.join("\n")}\n`;
}

/** Removes `key`'s line if present; no-op otherwise. */
export function removeIndexEntry(content: string, key: string): string {
  const lines = content.length > 0 ? content.split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === "")) : [];
  const idx = findEntryLine(lines, key);
  if (idx < 0) {
    return content;
  }
  lines.splice(idx, 1);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
