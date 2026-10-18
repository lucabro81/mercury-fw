import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CATALOG } from "../../../cli/src/catalog.ts";
import { catalogRows } from "./catalog-data.ts";

const DOCS = resolve(import.meta.dir, "..", "content", "docs", "plugins");
const PACKAGES = resolve(import.meta.dir, "..", "..", "..", "..", "packages");

describe("catalogRows, on this repo", () => {
  test("one row per package the CLI offers, none left out", () => {
    expect(catalogRows().map((r) => r.package).sort()).toEqual([...new Set(CATALOG.map((e) => e.package))].sort());
  });

  test("every package has its page, and every plugin page belongs to a package", () => {
    const slugs = catalogRows().map((r) => r.slug).sort();
    const pages = readdirSync(DOCS).filter((f) => f.endsWith(".mdx") && f !== "index.mdx").map((f) => f.replace(/\.mdx$/, "")).sort();
    expect(pages).toEqual(slugs);
  });

  test("each version is the one in the package's own package.json", () => {
    for (const row of catalogRows()) {
      const manifest = readdirSync(PACKAGES).map((bucket) => join(PACKAGES, bucket, row.slug, "package.json")).find((p) => existsSync(p));
      expect(manifest, row.package).toBeDefined();
      const { version } = JSON.parse(readFileSync(manifest!, "utf8"));
      expect(row.version, row.package).toBe(version === "0.0.0" ? null : version);
    }
  });
});
