#!/usr/bin/env bun
/**
 * Maintenance CLI for the wiki vault — runs INSIDE the Mercury container
 * (the vault is a Docker named volume, not a host path): `mfw vault` runs it
 * in a one-off container, by this path. Thin argv wrapper around
 * functions that already exist and are already tested (`wiki-note.ts`,
 * `vault-init.ts`) — no new write/read logic here, only routing.
 *
 * Deliberately does NOT expose `writeInferredNote` — that writer is
 * reserved exclusively for a deterministic, mechanical consolidation
 * process (see its own docstring in `wiki-note.ts`); a manual CLI writing
 * "agent-sourced" notes by hand would defeat that guarantee.
 *
 * `write-raw` has no `--author`/frontmatter options, unlike `write-curated`
 * — raw/ content is verbatim, un-triaged material (a pasted README, notes),
 * and its provenance is recovered from git history rather than a
 * schema field. The nightly self-review job (`self-review-tools.ts`) is
 * the only thing that reads raw/ back to triage it into curated/.
 *
 * `review` lists and decides the entries the nightly passes leave in
 * `review/` (`review-entries.ts`); `lock`/`unlock` set a curated doc's
 * `locked` (`updateNoteFrontmatter`), never a learned standard's, which only
 * the wiki's `locked` paths lock. `write-raw` refuses an entry over the
 * triage's limit (`raw-limit.ts`).
 *
 * `list`/`read`/`grep` intentionally bypass the per-person scoping in
 * `vault-access.ts`: that scoping exists to isolate what each
 * person (and the model on their behalf) can see; a maintainer running this
 * CLI is the operator, so these walk the whole vault, and only the vault.
 */
import { resolve, sep } from "node:path";
import { initVault } from "./vault-init.ts";
import { RAW_MAX_BYTES, rawEntryOverLimit } from "./raw-limit.ts";
import { decideReview, listReviews, readReview } from "./review-entries.ts";
import { readNote, updateNoteFrontmatter, writeCuratedNote, writeRawEntry } from "./wiki-note.ts";

function usage(): never {
  console.error(
    [
      "Usage: mfw vault <command> [args]",
      "",
      "Commands:",
      "  write-curated <curated/...path.md> [--author NAME]   body read from stdin",
      "  write-raw <raw/...path.md>                           body read from stdin",
      "  read <path>",
      "  list",
      "  grep <pattern>",
      "  review list",
      "  review show|accept|reject <id>",
      "  lock|unlock <curated/...path.md>",
      "",
      "Every path is relative to the vault root (as printed by `list`), including",
      "the leading `curated/`/`raw/` — write-curated/write-raw require it too, so",
      "paths are consistent across every command instead of meaning different things.",
    ].join("\n"),
  );
  process.exit(1);
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

async function main(): Promise<void> {
  const vaultPath = process.env.WIKI_VAULT_PATH;
  if (!vaultPath) {
    console.error("WIKI_VAULT_PATH is not set");
    process.exit(1);
  }
  await initVault(vaultPath);

  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "write-curated": {
      const vaultRelativePath = args[0];
      if (!vaultRelativePath) usage();
      if (!vaultRelativePath.startsWith("curated/")) {
        console.error(`path must start with "curated/" (got "${vaultRelativePath}") — see \`list\` for real examples`);
        process.exit(1);
      }
      const curatedRelativePath = vaultRelativePath.slice("curated/".length);
      const authorFlagIndex = args.indexOf("--author");
      const author = authorFlagIndex !== -1 ? args[authorFlagIndex + 1] : undefined;
      const body = await readStdin();
      if (!body.trim()) {
        console.error("empty body on stdin — nothing to write");
        process.exit(1);
      }
      await writeCuratedNote(
        vaultPath,
        curatedRelativePath,
        { author, last_updated: new Date().toISOString().slice(0, 10) },
        body.trimEnd(),
      );
      console.log(`wrote ${vaultRelativePath}`);
      break;
    }

    case "write-raw": {
      const vaultRelativePath = args[0];
      if (!vaultRelativePath) usage();
      if (!vaultRelativePath.startsWith("raw/")) {
        console.error(`path must start with "raw/" (got "${vaultRelativePath}")`);
        process.exit(1);
      }
      const rawRelativePath = vaultRelativePath.slice("raw/".length);
      const body = await readStdin();
      if (!body.trim()) {
        console.error("empty body on stdin — nothing to write");
        process.exit(1);
      }
      const entry = body.trimEnd();
      if (rawEntryOverLimit(entry)) {
        const size = Buffer.byteLength(entry, "utf-8");
        console.error(
          `${vaultRelativePath} is over the raw/ limit (${size} bytes, the limit is ${RAW_MAX_BYTES}): the nightly review triages only smaller entries`,
        );
        process.exit(1);
      }
      await writeRawEntry(vaultPath, rawRelativePath, entry);
      console.log(`wrote ${vaultRelativePath}`);
      break;
    }

    case "read": {
      const relativePath = args[0];
      if (!relativePath) usage();
      const vaultRoot = resolve(vaultPath);
      const target = resolve(vaultRoot, relativePath);
      if (!target.startsWith(vaultRoot + sep)) {
        console.error(`not a path in the vault: ${relativePath}`);
        process.exit(1);
      }
      const note = Bun.file(target);
      if (!(await note.exists())) {
        console.error(`no note at ${relativePath} (mfw vault list shows them)`);
        process.exit(1);
      }
      console.log(await note.text());
      break;
    }

    case "list": {
      const glob = new Bun.Glob("**/*.md");
      for await (const file of glob.scan({ cwd: vaultPath })) {
        console.log(file);
      }
      break;
    }

    case "grep": {
      const pattern = args[0];
      if (!pattern) usage();
      const regex = new RegExp(pattern, "i");
      const glob = new Bun.Glob("**/*.md");
      for await (const file of glob.scan({ cwd: vaultPath })) {
        const content = await Bun.file(`${vaultPath}/${file}`).text();
        content.split("\n").forEach((line, i) => {
          if (regex.test(line)) {
            console.log(`${file}:${i + 1}:${line}`);
          }
        });
      }
      break;
    }

    case "review": {
      const [sub, id] = args;
      if (sub === "list") {
        const entries = await listReviews(vaultPath);
        if (entries.length === 0) console.log("no review entries");
        for (const e of entries) console.log(`${e.id}  ${e.kind}  ${e.note}  ${e.opened_at}`);
        break;
      }
      if (!id || !["show", "accept", "reject"].includes(sub ?? "")) usage();
      const entry = await readReview(vaultPath, id);
      if (entry === null) {
        console.error(`no review entry ${id} (mfw vault review list shows them)`);
        process.exit(1);
      }
      if (sub === "show") {
        const lines = [`note: ${entry.note}`, `kind: ${entry.kind}`, `opened: ${entry.opened_at}`, `evidence: ${entry.evidence.join(", ")}`, "", entry.reason];
        if (entry.proposed !== undefined) lines.push("", "proposed:", "", entry.proposed);
        console.log(lines.join("\n"));
        break;
      }
      const decision = sub as "accept" | "reject";
      const { note, outcome } = await decideReview(vaultPath, id, decision, new Date().toISOString());
      console.log(`${decision === "accept" ? "accepted" : "rejected"} ${id}: ${note} ${outcome === "note-gone" ? "was already gone" : outcome}`);
      break;
    }

    case "lock":
    case "unlock": {
      const path = args[0];
      if (!path) usage();
      if (!path.startsWith("curated/")) {
        console.error("only a curated doc is locked here (curated/…); a person locks their own notes");
        process.exit(1);
      }
      const note = await readNote(vaultPath, path).catch(() => null);
      if (note === null) {
        console.error(`no note at ${path} (mfw vault list shows them)`);
        process.exit(1);
      }
      if (note.frontmatter.type !== "curated") {
        console.error(`${path} is the consolidation's (a learned standard): lock it with the wiki's locked paths instead`);
        process.exit(1);
      }
      await updateNoteFrontmatter(
        vaultPath,
        path,
        ({ locked: _locked, ...rest }) => (command === "lock" ? { ...rest, locked: true } : rest),
        `${command}: ${path}`,
      );
      console.log(`${command}ed ${path}`);
      break;
    }

    default:
      usage();
  }
}

await main();
