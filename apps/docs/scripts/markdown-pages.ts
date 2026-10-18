/**
 * After `astro build`: writes the Markdown version of every built page next
 * to it, at the page's address with `.md` in place of the trailing slash
 * (`dist/concepts/memory.md` for `/concepts/memory/`, `dist/index.md` for the
 * home). Pages Starlight didn't build (the HTTP API's Redocly page) are left out.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pageMarkdown } from "../src/lib/page-markdown.ts";

const DIST = join(import.meta.dir, "..", "dist");
const BASE = "/mercury-fw/";

/** Every `index.html` under `dir`. */
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "index.html" ? [path] : [];
  });
}

let written = 0;
for (const file of pages(DIST)) {
  const html = readFileSync(file, "utf8");
  if (!html.includes('class="sl-markdown-content"')) continue;
  const folder = relative(DIST, join(file, ".."));
  const target = folder === "" ? join(DIST, "index.md") : join(DIST, `${folder}.md`);
  writeFileSync(target, pageMarkdown(html, `${BASE}${folder ? `${folder}/` : ""}`));
  written++;
}
console.log(`[docs] ${written} Markdown pages written`);
