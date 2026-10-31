/**
 * Creates the GitHub Release of each published tag, the unified changelog the
 * docs site reads. Run by `publish.yml` after `scripts/publish.ts`, from the
 * release commit:
 *
 *   bun scripts/github-releases.ts [--dry-run]
 *
 * - It takes the tags on `HEAD` (`scripts/release.ts` puts them on the
 *   release commit).
 * - A framework release (`vX.Y.Z`) merges that version's sections from every
 *   package in the Changesets `fixed` group, whose own `<name>@<version>`
 *   tags get no Release; a plugin, channel or auth provider gets its own
 *   section. Dependency bumps are left out.
 * - Every tag picked gets a Release, with nothing asked of npm: the job runs
 *   only after `publish` succeeded, so every version tagged on the commit is
 *   uploaded, even while npm takes its few minutes to show it (asking npm
 *   then skipped the Release, #350). A tag that already has a Release is
 *   skipped, so a rerun creates only what's missing.
 * - The newest framework release is Latest; older framework releases and
 *   every package release never are.
 *
 * `gh` authenticates with `GH_TOKEN` in CI, with the maintainer's login locally.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { root, workspaces } from "./workspaces.ts";

/** A tag as a release: the framework's (`name` null) or one package's. */
export type ParsedTag = { kind: "framework" | "package"; name: string | null; version: string };

const FRAMEWORK_TAG = /^v(\d+\.\d+\.\d+.*)$/;
const PACKAGE_TAG = /^((?:@[^/@]+\/)?[^/@]+)@(\d+\.\d+\.\d+.*)$/;

/** Reads a tag, or `null` when it's neither `vX.Y.Z` nor `<name>@<version>`. */
export function parseTag(tag: string): ParsedTag | null {
  const framework = FRAMEWORK_TAG.exec(tag);
  if (framework) return { kind: "framework", name: null, version: framework[1]! };
  const pkg = PACKAGE_TAG.exec(tag);
  if (pkg) return { kind: "package", name: pkg[1]!, version: pkg[2]! };
  return null;
}

/** The `## <version>` section of a `CHANGELOG.md`, without its heading, or `null`. */
export function changelogSection(markdown: string, version: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

const KINDS = ["Major Changes", "Minor Changes", "Patch Changes"];

/** A dependency bump line: `- @mercury-fw/utils@0.59.0`, as a bullet or indented under an entry. */
const BUMP = /^\s*- (?:@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+\S*\s*$/;

/** A section's entries by kind, dependency bumps dropped. An entry is a
 * top-level bullet with the lines indented under it. */
function sectionEntries(section: string): Map<string, string[]> {
  const byKind = new Map<string, string[]>();
  let kind: string | null = null;
  let entry: string[] | null = null;
  const close = () => {
    if (kind === null || entry === null) return;
    const text = entry.join("\n").trimEnd();
    entry = null;
    if (text.startsWith("- Updated dependencies") || BUMP.test(text)) return;
    byKind.set(kind, [...(byKind.get(kind) ?? []), text]);
  };
  for (const line of section.split("\n")) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      close();
      kind = heading[1]!.trim();
    } else if (line.startsWith("- ")) {
      close();
      entry = [line];
    } else if (entry !== null && !BUMP.test(line)) {
      entry.push(line);
    }
  }
  close();
  return byKind;
}

/** What `releaseNotes` reads: the `fixed` group, and a package's `CHANGELOG.md` (or `null`). */
export type NotesContext = { fixed: string[]; changelog: (name: string) => string | null };

/**
 * The Markdown body of `tag`'s Release: for a framework tag the sections of
 * every package of the `fixed` group for that version, merged by kind, each
 * entry once; for a package tag its own section. Dependency bumps are left
 * out, and a release left with nothing says so.
 */
export function releaseNotes(tag: string, ctx: NotesContext): string {
  const parsed = parseTag(tag);
  const names = parsed === null ? [] : parsed.kind === "framework" ? ctx.fixed : [parsed.name!];
  const merged = new Map<string, string[]>();
  for (const name of names) {
    const md = ctx.changelog(name);
    const section = md === null ? null : changelogSection(md, parsed!.version);
    if (section === null) continue;
    for (const [kind, entries] of sectionEntries(section)) {
      const list = merged.get(kind) ?? [];
      for (const e of entries) if (!list.includes(e)) list.push(e);
      merged.set(kind, list);
    }
  }
  // The fixed group gives one changeset a different kind in different
  // packages: it stays under the highest one.
  const order = [...KINDS, ...[...merged.keys()].filter((k) => !KINDS.includes(k))];
  const seen = new Set<string>();
  for (const k of order) {
    const kept = (merged.get(k) ?? []).filter((e) => !seen.has(e));
    kept.forEach((e) => seen.add(e));
    merged.set(k, kept);
  }
  const groups = order.filter((k) => merged.get(k)!.length).map((k) => `### ${k}\n\n${merged.get(k)!.join("\n")}`);
  return groups.length === 0 ? "Dependency updates only." : groups.join("\n\n");
}

/** The tags of `tags` with no Release in `existing`, of a known shape: the
 * framework's oldest first, then the packages' by name and version. A
 * package of the `fixed` group gets none of its own: Changesets tags it
 * too, and the framework's Release already merges its section. */
export function releasesToCreate(tags: string[], existing: Set<string>, fixed: string[]): string[] {
  const parsed = tags
    .filter((t) => !existing.has(t))
    .map((t) => ({ tag: t, p: parseTag(t) }))
    .filter((x): x is { tag: string; p: ParsedTag } => x.p !== null);
  const framework = parsed.filter((x) => x.p.kind === "framework").sort((a, b) => Bun.semver.order(a.p.version, b.p.version));
  const packages = parsed
    .filter((x) => x.p.kind === "package" && !fixed.includes(x.p.name!))
    .sort((a, b) => a.p.name!.localeCompare(b.p.name!) || Bun.semver.order(a.p.version, b.p.version));
  return [...framework, ...packages].map((x) => x.tag);
}

/** The newest framework version among `tags`, or `null`. */
function newestFramework(tags: string[]): string | null {
  const versions = tags.map(parseTag).filter((p) => p?.kind === "framework").map((p) => p!.version);
  return versions.sort(Bun.semver.order).at(-1) ?? null;
}

/** The `gh release create` argv for `tag` (notes on stdin): Latest only for
 * the newest framework tag among `allTags`. */
export function createReleaseCommand(tag: string, allTags: string[]): string[] {
  const p = parseTag(tag)!;
  const title = p.kind === "framework" ? `Mercury Framework ${p.version}` : `${p.name} ${p.version}`;
  const latest = p.kind === "framework" && p.version === newestFramework(allTags);
  return ["gh", "release", "create", tag, "--title", title, "--notes-file", "-", "--verify-tag", latest ? "--latest" : "--latest=false"];
}

/** Creates the Release of each tag in `todo`, in order, through `create`; says so when there's none. Throws on the first that fails, naming its tag. */
export async function createReleases(
  todo: string[],
  { create, log }: { create: (tag: string) => Promise<void>; log: (line: string) => void },
): Promise<void> {
  if (todo.length === 0) log("No Release to create.");
  for (const tag of todo) {
    try {
      await create(tag);
    } catch (error) {
      throw new Error(`${tag}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false } },
  });

  /** `cmd`'s stdout lines; throws when it fails. */
  const lines = (...cmd: string[]): string[] => {
    const proc = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "inherit" });
    if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
    return proc.stdout.toString().split("\n").filter(Boolean);
  };

  const allTags = lines("git", "tag", "-l");
  const candidates = lines("git", "tag", "--points-at", "HEAD");
  const existing = new Set(lines("gh", "release", "list", "--limit", "1000", "--json", "tagName", "--jq", ".[].tagName"));

  const config = JSON.parse(readFileSync(join(root, ".changeset/config.json"), "utf-8")) as { fixed: string[][] };
  const dirs = new Map(workspaces().map((w) => [w.pkg.name, w.dir]));
  const ctx: NotesContext = {
    fixed: config.fixed[0] ?? [],
    changelog: (name) => {
      const file = dirs.has(name) ? join(dirs.get(name)!, "CHANGELOG.md") : null;
      return file !== null && existsSync(file) ? readFileSync(file, "utf-8") : null;
    },
  };

  await createReleases(releasesToCreate(candidates, existing, ctx.fixed), {
    create: async (tag) => {
      const cmd = createReleaseCommand(tag, allTags);
      const notes = releaseNotes(tag, ctx);
      if (values["dry-run"]) {
        console.log(`would run: ${cmd.join(" ")}\n${notes}\n`);
        return;
      }
      const proc = Bun.spawnSync(cmd, { cwd: root, stdin: Buffer.from(notes), stdout: "inherit", stderr: "inherit" });
      if (proc.exitCode !== 0) throw new Error("gh release create failed");
    },
    log: (line) => console.log(line),
  });
}
