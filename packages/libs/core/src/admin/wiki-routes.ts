/**
 * Admin panel's Wiki tab. `list`/`read`/`grep` walk the whole vault
 * directly (same trusted-admin-context choice `vault-cli.ts` already
 * makes — bypassing `wiki-read.ts`'s per-user `allowedRoots` scoping,
 * which exists to isolate what the MODEL can see per caller, not what an
 * operator running this panel can see).
 *
 * Curated edits go through a real, short-lived agent turn instead of
 * calling `writeCuratedNote` directly — see `editWikiViaModel`. Raw
 * writes and deletes have no model-facing tool today, so they stay
 * direct calls into `wiki-note.ts`, same as `vault-cli.ts`.
 */
import type { LanguageModel } from "ai";
import { createSessionHistory } from "../session/history.ts";
import { runTurn } from "../session/agent-turn.ts";
import { createSelfReviewTools } from "../wiki/self-review-tools.ts";
import { writeRawEntry, deleteCuratedEntry, deleteRawEntry } from "../wiki/wiki-note.ts";
import type { WikiGrepMatch } from "../wiki/wiki-read.ts";

export async function listWikiVault(vaultPath: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.md");
  const results: string[] = [];
  for await (const file of glob.scan({ cwd: vaultPath })) {
    results.push(file);
  }
  return results.sort();
}

export async function readWikiVaultFile(vaultPath: string, relativePath: string): Promise<string> {
  return Bun.file(`${vaultPath}/${relativePath}`).text();
}

export async function grepWikiVault(vaultPath: string, pattern: string): Promise<WikiGrepMatch[]> {
  // Case-insensitive, like every other wiki grep.
  const regex = new RegExp(pattern, "i");
  const files = await listWikiVault(vaultPath);
  const matches: WikiGrepMatch[] = [];
  for (const file of files) {
    const content = await readWikiVaultFile(vaultPath, file);
    content.split("\n").forEach((text, i) => {
      if (regex.test(text)) {
        matches.push({ path: file, line: i + 1, text });
      }
    });
  }
  return matches;
}

function stripPrefix(vaultRelativePath: string, prefix: string): string {
  if (!vaultRelativePath.startsWith(prefix)) {
    throw new Error(`path must start with "${prefix}" (got "${vaultRelativePath}")`);
  }
  return vaultRelativePath.slice(prefix.length);
}

/** `vaultRelativePath` must start with `raw/`, matching `vault-cli.ts`'s `write-raw`. */
export async function writeRawWikiEntry(vaultPath: string, vaultRelativePath: string, body: string): Promise<void> {
  await writeRawEntry(vaultPath, stripPrefix(vaultRelativePath, "raw/"), body);
}

/** `vaultRelativePath` must start with `curated/` or `raw/` — nothing else is deletable from here. */
export async function deleteWikiEntry(vaultPath: string, vaultRelativePath: string): Promise<void> {
  if (vaultRelativePath.startsWith("curated/")) {
    await deleteCuratedEntry(vaultPath, stripPrefix(vaultRelativePath, "curated/"));
    return;
  }
  if (vaultRelativePath.startsWith("raw/")) {
    await deleteRawEntry(vaultPath, stripPrefix(vaultRelativePath, "raw/"));
    return;
  }
  throw new Error(`can only delete curated/ or raw/ entries (got "${vaultRelativePath}")`);
}

/**
 * Sends `instruction` through a real, short-lived agent turn scoped ONLY to
 * the operator's wiki tools over the common area (list, read, grep and
 * `write_curated` from `createSelfReviewTools`, the same ones the nightly
 * review uses): never the full toolset a normal channel gets, so this box
 * can't touch Jira/Bitbucket, and never a person's area. Reuses the same
 * commit path (`writeCuratedNote` -> git commit); this function has no write
 * logic of its own. History is fresh per call, never persisted — this isn't a
 * real session.
 */
export async function editWikiViaModel(model: LanguageModel, vaultPath: string, instruction: string): Promise<string> {
  const history = createSessionHistory(async () => "");
  const { list_files, read_file, grep, write_curated } = createSelfReviewTools({ vaultPath });
  const tools = { list_files, read_file, grep, write_curated };
  return runTurn(history, instruction, {
    model,
    tools,
    system:
      "You are Mercury's wiki maintenance assistant, invoked from the admin panel. You can only use the " +
      "wiki tools available to you (list_files, read_file, grep, write_curated) — you have no access to Jira, " +
      "Bitbucket, or any other tool. Follow the operator's instruction precisely and report back what you did.",
  });
}
