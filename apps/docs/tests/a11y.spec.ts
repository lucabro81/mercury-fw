/**
 * WCAG 2.2 AA on the built site: an axe audit of every page written by hand
 * (and one generated reference page), in both themes, plus the keyboard path
 * every page must offer.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every page the site writes by hand, plus one generated reference page and a missing one (the 404). */
const DIST = join(import.meta.dirname, "..", "dist");
function builtPages(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = `${prefix}${entry.name}/`;
    if (path === "reference/api/" || path === "reference/http-api/" || path === "_astro/" || path === "pagefind/") return [];
    const nested = builtPages(join(dir, entry.name), path);
    return existsSync(join(dir, entry.name, "index.html")) ? [path, ...nested] : nested;
  });
}
const PAGES = ["", ...builtPages(DIST), "reference/api/types/plugin-types/type-aliases/plugin/", "a-page-that-does-not-exist/"];

/** Opens `path` with the theme stored the way Starlight's theme picker stores it. */
async function open(page: Page, path: string, theme: "dark" | "light") {
  await page.addInitScript((t) => localStorage.setItem("starlight-theme", t), theme);
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

for (const theme of ["dark", "light"] as const) {
  for (const path of PAGES) {
    test(`${theme}: /${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await open(page, path, theme);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      expect(summary).toEqual([]);
    });
  }
}

test("the first Tab reaches a visible skip link that moves focus to the content", async ({ page }) => {
  await open(page, "getting-started/first-agent/", "light");
  await page.keyboard.press("Tab");
  const skip = page.locator(":focus");
  await expect(skip).toHaveText(/skip to content/i);
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#_top$/);
});

test("with no stored choice the theme follows the system", async ({ browser }) => {
  for (const colorScheme of ["dark", "light"] as const) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto("getting-started/first-agent/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await context.close();
  }
});

test("nothing animates", async ({ page }) => {
  await open(page, "", "dark");
  const animated = await page.evaluate(() =>
    [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return s.animationName !== "none" || (s.transitionDuration.split(",").some((d) => parseFloat(d) > 0));
    }).length,
  );
  expect(animated).toBe(0);
});

test("the open search dialog has no WCAG 2.2 AA violations", async ({ page }) => {
  await open(page, "concepts/memory/", "dark");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const results = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test("a theme picked by hand overrides the system and is remembered on the next page", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto("concepts/memory/");
  await page.getByRole("combobox", { name: "Select theme" }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto("concepts/channels/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("combobox", { name: "Select theme" }).selectOption("auto");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await context.close();
});
