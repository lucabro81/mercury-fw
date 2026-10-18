/**
 * Every internal link of the built site (`dist/`) leads to a page that exists:
 * a renamed or removed page fails here instead of on a reader.
 */
import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = join(import.meta.dirname, "..", "dist");
const BASE = "/mercury-fw/";

/** Every HTML file under `dir`. */
function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

test("no internal link is broken", () => {
  const broken: string[] = [];
  for (const file of htmlFiles(DIST)) {
    const folder = relative(DIST, join(file, ".."));
    const pageUrl = new URL(`https://site${BASE}${folder ? `${folder}/` : ""}`);
    for (const [, href] of readFileSync(file, "utf8").matchAll(/href="([^"#?]+)/g)) {
      if (/^(https?:|mailto:|data:)/.test(href!)) continue;
      const path = new URL(href!, pageUrl).pathname;
      const target = path.startsWith(BASE) ? join(DIST, path.slice(BASE.length)) : null;
      const exists = target !== null && (existsSync(join(target, "index.html")) || (existsSync(target) && statSync(target).isFile()));
      if (!exists) broken.push(`${relative(DIST, file)} → ${href}`);
    }
  }
  expect(broken).toEqual([]);
});
