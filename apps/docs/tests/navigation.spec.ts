/**
 * The way around the built site: the section the header marks as current, and
 * on a phone-sized screen the menu every page offers (Starlight's on pages with
 * a sidebar, the header's own on the others) and the home's plain title.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PHONE = { width: 375, height: 812 };
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("the header marks only the section a page belongs to", async ({ page }) => {
  // Guards against a match anywhere in the path: /concepts/plugins/ was marked
  // as both Docs and Plugins.
  await page.goto("concepts/plugins/");
  await expect(page.locator(".mfw-sections a[aria-current=page]")).toHaveText(["Docs"]);
  await page.goto("plugins/plugin-jira/");
  await expect(page.locator(".mfw-sections a[aria-current=page]")).toHaveText(["Plugins"]);
  await page.goto("");
  await expect(page.locator(".mfw-sections a[aria-current=page]")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: PHONE });

  test("the home shows its title as text instead of the character field", async ({ page }) => {
    await page.goto("");
    await expect(page.locator(".mfw-field")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mercury Framework");
  });

  test("the home's menu opens with the sections, the theme and GitHub, and closes with Escape", async ({ page }) => {
    await page.goto("");
    const menu = page.locator("#mfw-menu");
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("navigation", { name: "Sections" }).getByRole("link")).toHaveText([
      "Getting started",
      "Docs",
      "Plugins",
      "Changelog",
    ]);
    await expect(menu.getByRole("link", { name: "GitHub" })).toBeVisible();
    await expect(menu.getByRole("combobox", { name: "Select theme" })).toBeVisible();
    const results = await new AxeBuilder({ page }).include("#mfw-menu").withTags(WCAG).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("a docs page's menu starts with the sections and ends with GitHub and the theme", async ({ page }) => {
    await page.goto("concepts/plugins/");
    await page.getByRole("button", { name: "Menu" }).click();
    const pane = page.locator("#starlight__sidebar");
    await expect(pane.getByRole("navigation", { name: "Sections" }).getByRole("link")).toHaveText([
      "Getting started",
      "Docs",
      "Plugins",
      "Changelog",
    ]);
    await expect(pane.locator(".mfw-menu-sections a[aria-current=page]")).toHaveText(["Docs"]);
    await expect(pane.getByRole("link", { name: "GitHub" })).toBeAttached();
    await expect(pane.getByRole("combobox", { name: "Select theme" })).toBeAttached();
  });
});

test("on a wide screen neither menu shows and the sections are in the header", async ({ page }) => {
  await page.goto("");
  await expect(page.getByRole("button", { name: "Menu" })).toBeHidden();
  await expect(page.locator(".mfw-sections")).toBeVisible();
  await page.goto("concepts/plugins/");
  await expect(page.locator(".mfw-menu-sections")).toBeHidden();
});
