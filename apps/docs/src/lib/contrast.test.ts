import { describe, expect, test } from "bun:test";
import { contrastRatio, readTokens } from "./contrast.ts";

const theme = await Bun.file(new URL("../styles/theme.css", import.meta.url)).text();

describe("contrastRatio", () => {
  test("black on white is 21:1, a color on itself 1:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#0e7490", "#0e7490")).toBeCloseTo(1, 5);
  });

  test("order doesn't matter, and the short form reads like the long one", () => {
    expect(contrastRatio("#fff", "#767676")).toBeCloseTo(contrastRatio("#767676", "#ffffff"), 10);
    // #767676 on white is the classic 4.54:1, the lightest gray passing AA.
    expect(contrastRatio("#767676", "#fff")).toBeCloseTo(4.54, 2);
  });
});

describe("readTokens", () => {
  test("reads the --mfw-* properties of the block opened by the exact selector", () => {
    const css = `:root { --mfw-bg: #111; --other: 1px; }\n:root[data-theme="light"] { --mfw-bg: #fafafa; }`;
    expect(readTokens(css, ":root")).toEqual({ bg: "#111" });
    expect(readTokens(css, ':root[data-theme="light"]')).toEqual({ bg: "#fafafa" });
  });

  test("a selector with no block fails loudly", () => {
    expect(() => readTokens(":root { --mfw-bg: #111; }", ".missing")).toThrow(".missing");
  });
});

// WCAG 2.2 AA: 4.5:1 for every text (muted text included, since docs use it
// at body size), 3:1 for interface parts such as the focus ring.
for (const [name, selector] of [
  ["dark", ":root"],
  ["light", ':root[data-theme="light"]'],
] as const) {
  describe(`${name} theme`, () => {
    const t = readTokens(theme, selector);

    test("defines every token the checks below need", () => {
      for (const key of ["bg", "surface", "text", "text-muted", "accent", "border"]) {
        expect(t[key], `--mfw-${key}`).toMatch(/^#[0-9a-f]{3,6}$/i);
      }
    });

    for (const fg of ["text", "text-muted", "accent"]) {
      for (const bg of ["bg", "surface"]) {
        test(`${fg} on ${bg} reaches 4.5:1`, () => {
          expect(contrastRatio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    test("the accent, used for the focus ring, reaches 3:1 against the surface it sits next to", () => {
      expect(contrastRatio(t.accent!, t.surface!)).toBeGreaterThanOrEqual(3);
    });
  });
}
