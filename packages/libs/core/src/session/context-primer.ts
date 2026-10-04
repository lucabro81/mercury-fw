/**
 * Builds the synthetic primer text seeded into a brand-new Google Chat
 * session's history (see `history.ts`'s `primer` param): the wiki's own
 * index (same for every user, not tied to any prior session), the wiki
 * facts the user's last closed session actually reinforced, plus that same
 * session's own episodic entries. Empty string when there's nothing —
 * enrichment, a caller must work fine without it. Deliberately not
 * similarity retrieval: there's no query yet to compare against at session
 * start, only "what happened last time" (see `getLastSessionEpisodicSummaries`)
 * plus "what's in the wiki right now".
 */
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EpisodicSummary } from "../memory/episodic-store.ts";
import type { listWikiFilesInRoots, readWikiFileInRoots, readIndexFile } from "../wiki/wiki-read.ts";
import { userArea } from "../identity/user-key.ts";

export type ContextPrimerDeps = {
  vaultPath: string;
  /** Already scoped to the last closed session's own sessionKey — see `getLastSessionEpisodicSummaries`. */
  getLastSessionEntries: (key: string) => Promise<EpisodicSummary[]>;
  listWikiFilesInRootsFn: typeof listWikiFilesInRoots;
  readWikiFileInRootsFn: typeof readWikiFileInRoots;
  readIndexFileFn: typeof readIndexFile;
  /** Where a skipped section says why (the recap, when Qdrant doesn't answer). */
  log: (msg: string) => void;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

/** Same frontmatter shape `semantic-consolidation.ts` already parses (`derived_from: string[]`) — only `inferred` notes carry it, a `resolved`/`curated` note yields none. */
function derivedFromTimestamps(text: string): string[] {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return [];
  }
  const frontmatter = parseYaml(match[1] as string) as { derived_from?: unknown };
  return Array.isArray(frontmatter.derived_from) ? frontmatter.derived_from : [];
}

/** The note's content after its frontmatter block — matches `writeNoteFile`'s `---\n<yaml>---\n\n<body>\n` layout. */
function noteBody(text: string): string {
  const match = FRONTMATTER_RE.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

/** Extracts a confirmation note's `status` field — `undefined` for anything not shaped like one (missing/unparseable frontmatter). */
function noteStatus(text: string): string | undefined {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return undefined;
  }
  const frontmatter = parseYaml(match[1] as string) as { status?: unknown };
  return typeof frontmatter.status === "string" ? frontmatter.status : undefined;
}

/**
 * Tokens of this person's still-`"pending"` confirmation notes
 * (`users/<key>/confirmations/<token>.md` — see `writeConfirmationNote`
 * in `wiki-note.ts`). Deliberately a separate lookup from the "Known facts"
 * cross-reference below: this subtree isn't correlated to the last
 * session's episodic timestamps, it's simply "whatever is still open right
 * now" for this user, regardless of which session staged it.
 */
async function pendingConfirmationTokens(key: string, deps: ContextPrimerDeps): Promise<string[]> {
  const confirmationsRoot = resolve(deps.vaultPath, userArea(key), "confirmations");
  const files = await deps.listWikiFilesInRootsFn(deps.vaultPath, [confirmationsRoot]);
  const tokens: string[] = [];
  for (const file of files) {
    const text = await deps.readWikiFileInRootsFn(deps.vaultPath, [confirmationsRoot], file);
    if (noteStatus(text) === "pending") {
      tokens.push(file.split("/").pop()!.replace(/\.md$/, ""));
    }
  }
  return tokens;
}

/**
 * Text of the primer for the person `key`, built from injected deps only — never
 * touches Qdrant or the filesystem directly, so tests supply fakes and
 * `index.ts` supplies the real Qdrant-backed episodic query and wiki reads.
 */
export async function buildContextPrimer(key: string, deps: ContextPrimerDeps): Promise<string> {
  // Episodic memory is enrichment: without Qdrant the primer goes on without
  // the recap instead of failing the turn.
  const entries = await deps.getLastSessionEntries(key).catch((err: unknown) => {
    deps.log(`last session for ${key} unavailable, primer built without it: ${String(err)}`);
    return [];
  });
  // Checked regardless of `entries` — a pending confirmation isn't tied to
  // "was there a prior episodic session", it's simply still open right now.
  const pendingTokens = await pendingConfirmationTokens(key, deps);
  // Same for every user (curated/ has no per-user scoping) — checked
  // regardless of prior session too, so even a first-ever session gets
  // pointed at what's in the wiki right now.
  const indexContent = (await deps.readIndexFileFn(deps.vaultPath)).trim();

  if (entries.length === 0 && pendingTokens.length === 0 && indexContent.length === 0) {
    return "";
  }

  const sections: string[] = [];

  if (indexContent.length > 0) {
    sections.push(`Wiki index:\n${indexContent}`);
  }

  if (entries.length > 0) {
    const entryTimestamps = new Set(entries.map((e) => e.timestamp));
    const inferredRoot = resolve(deps.vaultPath, userArea(key), "inferred");
    const files = await deps.listWikiFilesInRootsFn(deps.vaultPath, [inferredRoot]);

    const facts: string[] = [];
    for (const file of files) {
      const text = await deps.readWikiFileInRootsFn(deps.vaultPath, [inferredRoot], file);
      const timestamps = derivedFromTimestamps(text);
      if (!timestamps.some((ts) => entryTimestamps.has(ts))) {
        continue;
      }
      const topic = file.split("/").pop()!.replace(/\.md$/, "");
      const body = noteBody(text);
      if (body) {
        facts.push(`${topic}: ${body}`);
      }
    }

    if (facts.length > 0) {
      sections.push(`Known facts:\n${facts.map((f) => `- ${f}`).join("\n")}`);
    }
    sections.push(`Last session:\n${entries.map((e) => `- ${e.summary}`).join("\n")}`);
  }

  // Deliberately opaque: just the token, no command, no "still pending"
  // narrative — see pendingConfirmationTokens's own doc comment for why.
  // Resolving it into something meaningful requires the model to
  // deliberately call resolve_reference (wiki-tools.ts) with the token.
  if (pendingTokens.length > 0) {
    sections.push(`Riferimenti aperti:\n${pendingTokens.map((t) => `- [REQ:${t}]`).join("\n")}`);
  }

  return sections.join("\n\n");
}
