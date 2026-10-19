/**
 * The catalog rows for this build: the CLI's own catalog joined with the
 * version in each first-party package's `package.json`, read from the repo.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CATALOG } from "../../../cli/src/catalog.ts";
import { catalogIndex, type CatalogRow } from "./catalog.ts";

/** The repo's `packages/`, from the docs workspace Astro runs in (bundling moves this module, so not relative to it). */
const PACKAGES = resolve(process.cwd(), "../../packages");

/** Every workspace package's version under `packages/`, by name. */
function workspaceVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const bucket of readdirSync(PACKAGES)) {
    const bucketDir = join(PACKAGES, bucket);
    for (const pkg of readdirSync(bucketDir)) {
      const manifest = join(bucketDir, pkg, "package.json");
      if (!existsSync(manifest)) continue;
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; version: string };
      versions[name] = version;
    }
  }
  return versions;
}

/** The catalog index, one row per first-party package. */
export function catalogRows(): CatalogRow[] {
  return catalogIndex(CATALOG, workspaceVersions());
}

/** The row of one package, by its page slug; throws for an unknown one. */
export function catalogRow(slug: string): CatalogRow {
  const row = catalogRows().find((r) => r.slug === slug);
  if (!row) throw new Error(`catalog: no package for page ${slug}`);
  return row;
}

/** How each role reads on the site. */
export const KIND_LABEL: Record<CatalogRow["kinds"][number], string> = {
  channel: "Channel",
  auth: "Auth provider",
  directory: "Directory",
  tool: "Tool plugin",
};
