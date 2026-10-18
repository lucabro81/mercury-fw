/**
 * WCAG contrast between the site's theme colors, read straight from the theme
 * file, so a color change that breaks accessibility fails the tests.
 */

/** Expands `#abc` to `#aabbcc` and returns its three channels, 0–255. */
function channels(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Relative luminance, as WCAG 2 defines it. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between two hex colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The `--mfw-*` custom properties declared in the block whose selector is
 * exactly `selector`, keyed without the prefix. Throws when there's no such
 * block.
 */
export function readTokens(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no block for ${selector}`);
  const tokens: Record<string, string> = {};
  for (const [, key, value] of block[1]!.matchAll(/--mfw-([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[key!] = value!.trim();
  }
  return tokens;
}
