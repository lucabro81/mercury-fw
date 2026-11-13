/**
 * Deterministic pre-check for the self-review job (see
 * `self-review-runner.ts`'s index/orphan pass): which curated docs are
 * referenced by neither `index.md` nor a `[[wikilink]]` from another
 * curated doc. Detection only — what to do about an orphan (add it to
 * the index, add a cross-link, both) is left to the LLM's judgment;
 * that decision can't be made deterministically.
 */
import { basename, resolve } from "node:path";
import { listWikiFilesInRoots, readWikiFileInRoots, readIndexFile } from "./wiki-read.ts";

/** Both `[[jira-fields]]` and `[[jira-fields|display text]]` resolve to "jira-fields". */
function extractWikilinks(content: string): Set<string> {
  const links = new Set<string>();
  const regex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    links.add(match[1]!.trim());
  }
  return links;
}

export async function findOrphanCuratedDocs(vaultPath: string): Promise<string[]> {
  const curatedRoot = resolve(vaultPath, "curated");
  const curatedFiles = await listWikiFilesInRoots(vaultPath, [curatedRoot]);
  const indexContent = await readIndexFile(vaultPath);

  const fileContents = new Map<string, string>();
  for (const file of curatedFiles) {
    fileContents.set(file, await readWikiFileInRoots(vaultPath, [curatedRoot], file));
  }
  const indexLinks = extractWikilinks(indexContent);

  const orphans: string[] = [];
  for (const file of curatedFiles) {
    const curatedRelative = file.slice("curated/".length).replace(/\.md$/, "");
    const base = basename(curatedRelative);
    // index.md can mention a doc either as a plain path or as a [[wikilink]]
    // (the Karpathy-pattern index is itself just markdown with wikilinks).
    const referencedByIndex =
      indexContent.includes(file) || indexLinks.has(curatedRelative) || indexLinks.has(base);

    // "Referenced" means linked from ANOTHER doc — a doc's own [[self-link]]
    // doesn't count, or every self-linking doc would wrongly stop being orphaned.
    let referencedByLink = false;
    for (const [otherFile, content] of fileContents) {
      if (otherFile === file) continue;
      const links = extractWikilinks(content);
      if (links.has(curatedRelative) || links.has(base)) {
        referencedByLink = true;
        break;
      }
    }

    if (!referencedByIndex && !referencedByLink) {
      orphans.push(file);
    }
  }

  return orphans.sort();
}
