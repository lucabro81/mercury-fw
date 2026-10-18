import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CATALOG } from "../../../cli/src/catalog.ts";
import { catalogRows } from "./catalog-data.ts";

const DOCS = resolve(import.meta.dir, "..", "content", "docs", "plugins");
const PACKAGES = resolve(import.meta.dir, "..", "..", "..", "..", "packages");

describe("catalogRows, on this repo", () => {
  test("one row per package the CLI offers, none left out", () => {
    expect(catalogRows().map((r) => r.package).sort()).toEqual([...new Set(CATALOG.map((e) => e.package))].sort());
  });

  test("every package has its page", () => {
    const missing = catalogRows().filter((r) => !existsSync(join(DOCS, `${r.slug}.mdx`)));
    expect(missing.map((r) => r.slug)).toEqual([]);
  });

  test("each version is the one in the package's own package.json", () => {
    const http = catalogRows().find((r) => r.package === "@mercury-fw/channel-http")!;
    const manifest = JSON.parse(readFileSync(join(PACKAGES, "channels", "channel-http", "package.json"), "utf8"));
    expect(http.version).toBe(manifest.version);
  });
});
