/**
 * The plugin catalog's index: one row per first-party package, built from the
 * same hand-written catalog `mfw create` offers (`apps/cli/src/catalog.ts`)
 * plus each package's current version. Only the source changes once plugins
 * describe themselves; the pages reading these rows stay as they are.
 */

/** The fields of a CLI catalog entry this index reads. */
export type CatalogSource = {
  id: string;
  kind: "channel" | "auth" | "tool" | "directory";
  package: string;
  env: Array<{ name: string; comment: string; value?: string }>;
};

/** An environment variable as the catalog shows it. */
export type CatalogEnv = { name: string; description: string; required: boolean; example?: string };

/** One package of the catalog, with the page that documents it. */
export type CatalogRow = {
  package: string;
  /** The package name without its scope: the page's path under `/plugins/`. */
  slug: string;
  /** The roles it plays in an app, in the order the CLI catalog lists them. */
  kinds: CatalogSource["kind"][];
  /** `null` while the package has never been published. */
  version: string | null;
  env: CatalogEnv[];
};

const KIND_ORDER: CatalogSource["kind"][] = ["channel", "auth", "directory", "tool"];

const REQUIRED = /^Required:\s*/;

/** Turns a CLI catalog env entry into what the catalog shows. */
function toEnv(entry: CatalogSource["env"][number]): CatalogEnv {
  const required = REQUIRED.test(entry.comment);
  return {
    name: entry.name,
    description: entry.comment.replace(REQUIRED, ""),
    required,
    ...(entry.value ? { example: entry.value } : {}),
  };
}

/**
 * Groups the catalog entries by package, ordered by the package's first role
 * (channels, auth providers, directories, tools) and then by name. `versions`
 * maps each package to its `package.json` version; a package missing from it
 * throws, since a row without a version would be a wrong page.
 */
export function catalogIndex(entries: CatalogSource[], versions: Record<string, string>): CatalogRow[] {
  const rows = new Map<string, CatalogRow>();
  for (const entry of entries) {
    const version = versions[entry.package];
    if (version === undefined) throw new Error(`catalog: no version for ${entry.package}`);
    let row = rows.get(entry.package);
    if (!row) {
      row = {
        package: entry.package,
        slug: entry.package.replace(/^@[^/]+\//, ""),
        kinds: [],
        version: version === "0.0.0" ? null : version,
        env: [],
      };
      rows.set(entry.package, row);
    }
    if (!row.kinds.includes(entry.kind)) row.kinds.push(entry.kind);
    for (const env of entry.env) {
      if (!row.env.some((e) => e.name === env.name)) row.env.push(toEnv(env));
    }
  }
  const rank = (row: CatalogRow) => KIND_ORDER.indexOf(row.kinds[0]!);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.package.localeCompare(b.package));
}
