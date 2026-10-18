/**
 * The built site (`dist/`) holds together: every internal link leads to a page
 * that exists and, when it names a section, to a section that exists; every
 * page Starlight built has its Markdown version, with the rendered content and
 * not the MDX source.
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

/** The page file a site path points to, or null when there's none. */
function pageFile(path: string): string | null {
  if (!path.startsWith(BASE)) return null;
  const target = join(DIST, path.slice(BASE.length));
  if (existsSync(join(target, "index.html"))) return join(target, "index.html");
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

const ids = new Map<string, Set<string>>();
/** The ids an HTML file declares. */
function idsOf(file: string): Set<string> {
  let found = ids.get(file);
  if (!found) {
    found = new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
    ids.set(file, found);
  }
  return found;
}

test("no internal link is broken, sections included", () => {
  const broken: string[] = [];
  for (const file of htmlFiles(DIST)) {
    const folder = relative(DIST, join(file, ".."));
    const pageUrl = new URL(`https://site${BASE}${folder ? `${folder}/` : ""}`);
    for (const [, raw] of readFileSync(file, "utf8").matchAll(/href="([^"]+)"/g)) {
      const href = raw!.replace(/&amp;/g, "&");
      if (/^(https?:|mailto:|data:)/.test(href)) continue;
      const url = new URL(href, pageUrl);
      const target = pageFile(url.pathname);
      if (!target) {
        broken.push(`${relative(DIST, file)} → ${href}`);
        continue;
      }
      const fragment = decodeURIComponent(url.hash.slice(1));
      if (fragment && target.endsWith(".html") && !idsOf(target).has(fragment)) broken.push(`${relative(DIST, file)} → ${href} (no such section)`);
    }
  }
  expect(broken).toEqual([]);
});

test("every page Starlight built has its Markdown version, rendered and not MDX source", () => {
  const problems: string[] = [];
  for (const file of htmlFiles(DIST)) {
    if (!file.endsWith("index.html") || !readFileSync(file, "utf8").includes('class="sl-markdown-content"')) continue;
    const folder = relative(DIST, join(file, ".."));
    const md = folder === "" ? join(DIST, "index.md") : join(DIST, `${folder}.md`);
    if (!existsSync(md)) {
      problems.push(`${folder || "/"}: no Markdown version`);
      continue;
    }
    const text = readFileSync(md, "utf8");
    if (!text.startsWith("# ")) problems.push(`${folder}: no title`);
    // Code is allowed to show imports and generics; prose isn't allowed MDX.
    const prose = text.replace(/^ *```[\s\S]*?^ *```$/gm, "").replace(/`[^`\n]*`/g, "");
    if (/^import\s|<[A-Z][A-Za-z]+[\s/>]/m.test(prose)) problems.push(`${folder}: MDX source left in`);
  }
  expect(problems).toEqual([]);
});

test("a plugin page's Markdown carries the facts its component generates", () => {
  const md = readFileSync(join(DIST, "plugins", "plugin-jira.md"), "utf8");
  expect(md).toContain("@mercury-fw/plugin-jira");
  expect(md).toContain("`JIRA_SITE_URL`");
  expect(md).toContain("**Required.** ");
});
