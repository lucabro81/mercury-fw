# @mercury-fw/wiki

The wiki of a [Mercury](https://github.com/lucabro81/mercury-fw) agent: Markdown notes in a git repository, the vault, that the team shares and each person keeps for themselves, read and written by the model through its tools. It's the plugin `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#the-wiki).

```ts
import { wiki } from "@mercury-fw/wiki";

const teamWiki = wiki();

export default defineMercuryConfig({
  plugins: [conversation, teamWiki],
  context: { profiles: { default: { conversation, layers: [teamWiki], budget: { maxChars: 8000 } } } },
  // …
});
```

Declared in `plugins`, it gives the model its tools; listed among a profile's `layers`, the same object, it also puts the vault's `index.md` in front of the model at the start of each session.

| Option | |
|---|---|
| `vaultPath` | Where the vault lives, `WIKI_VAULT_PATH` when left out. With neither, the app stops at startup. In a scaffolded app it's a Docker volume mounted at `/app/wiki-vault`. |
| `review` | When the nightly review runs: `{ at, timeZone, dreaming }`, `at` a time of day (`"HH:MM"`, `"03:00"` when left out) and `timeZone` an IANA name, the instance's (`i18n.timeZone`) when left out. Every day at `"03:00"` when left out, `false` for none. A time or a time zone that can't be stops the app at startup. `dreaming: {}` turns on the [dreaming pass](#dreaming), last in the same run; `dreaming: { k }` says how many distinct conversations decide a note's status (3 when left out, a whole number of at least 1 or the app stops at startup). Off when left out or with `dreaming: false`; a new app made with `mfw create` has it on. |
| `locked` | Paths under `curated/`, as globs (`["curated/confluence/**"]`), whose documents only people change: the nightly review leaves them alone (see [Locked notes](#locked-notes)). For whole folders copied from an official source. A path outside `curated/` stops the app at startup. |

## The vault

At startup the plugin makes the vault a git repository with its folders if it isn't one yet (an empty volume on the first start), and every write is a commit, so the history of every note is the vault's own. The folders:

- `curated/`, the team's common knowledge (conventions, docs, project status), which everyone reads;
- `users/<key>/`, one area per person (`<key>` is Mercury's identity for them, `<provider>:<id>`, encoded), which the model sees as `personal/`: `personal/notes/` is what it writes for that person, `personal/inferred/` what Mercury learned about them (written by the long-term memory, `@mercury-fw/memory`, through the wiki's `notes`);
- `raw/`, material pasted in as it is, waiting for the nightly review to sort it into `curated/`;
- `review/`, what the nightly review left for a person to decide (see [Review entries](#review-entries));
- `index.md`, kept by the nightly review, a line for each document of `curated/`.

Nobody sees anyone else's area. The model can't write the common area directly: `promote_note` copies one of the person's notes there, and only once they confirm it with the token Mercury hands back. The operator's tools (`mfw vault`, the nightly review) see the whole vault. A vault from an older Mercury, with the notes under `inferred/users/<id>/`, gets them moved into each person's area at startup, as one commit; an id that doesn't say which provider it came from stays where it is, with a line in the log.

Writes that depend on what's there (an `index.md` update, a promotion) decide inside the same queue the write goes through, so a concurrent update is never lost. The nightly review rewrites or deletes only the version of a document it read, and rereads it when someone changed it meanwhile.

## What the model gets

The tools, for the person the turn is for (none for a turn acting as nobody):

| Tool | |
|---|---|
| `list_files` | Every document the person can see, as `curated/…` and `personal/…` paths. |
| `read_file` | One of them. |
| `grep` | The lines matching a regular expression, case ignored. |
| `write_file` | Writes a note below `personal/notes/`, replacing the whole file. With `locked: true` the note is locked, with `locked: false` unlocked; left out, it keeps its lock. The model sets it only when the person asks. |
| `promote_note` | Copies one of the person's notes into `curated/`, once they confirm it. |

The model reads what they're for in the system prompt, and when to look in the wiki first: before trying a tool or answering from what it knows, for anything about the team's documentation, projects and conventions. Their status lines are under the `wiki.status.read`, `wiki.status.write` and `wiki.status.search` keys.

## The nightly review

Every day at the time `review` says, the background model goes through the vault in three passes, each a job of its own on Mercury's queue (the traces show them as `background.job` events named `wiki:review-raw`, `wiki:review-index`, `wiki:review-contradictions`), then, when it's on, the dreaming pass, one job for each note it checks (`wiki:dreaming`). A pass that fails is logged and the others go on. A day the agent wasn't running isn't made up.

It's easy to lose track of who touches what, so here's the vault from the review's side first:

| Folder | Who writes it | Who reads it |
|---|---|---|
| `curated/` | people (`mfw vault write-curated`, git on the volume), `promote_note` once confirmed, the nightly review | everyone's model, the nightly review |
| `curated/standards/<tool>-<topic>.md` | the corrections plugin, by counting (see [What the memory writes here](#what-the-memory-writes-here)) | everyone's model, the nightly review |
| `personal/notes/` | the model, for that person | that person's model |
| `personal/inferred/` | the memory plugin, by counting | that person's model |
| `raw/` | people (`mfw vault write-raw`) | the nightly review |
| `review/` | the nightly review, the dreaming pass | people (`mfw vault review`); never the model |
| `index.md` | the nightly review | everyone's model, at the start of a session |

The three passes of the review never see anyone's area, only `curated/` and `raw/`; the dreaming pass reads a person's notes, each with that person's conversations only. Then the passes, in the order they run:

| Pass | Reads | Writes | Leaves behind |
|---|---|---|---|
| **raw triage**, when `raw/` has something | `raw/`, `curated/` | `curated/`, `index.md`, `raw/` (deleting) | each entry merged into a document, promoted to a new one, or discarded, then deleted from `raw/` |
| **index**, when a document isn't in `index.md` | `curated/`, `index.md` | `index.md`, `curated/` (cross-links) | a line in the index for each orphan |
| **contradictions**, every time | `curated/` | `curated/`, `index.md` | contradictions fixed and cross-links added where it's confident, duplicates deleted |
| **dreaming**, when it's on | the notes used since the last pass, the curated documents the review wrote that have no status yet, and the conversations those notes were used in | the notes' frontmatter, a person's notes, `review/` | a status on each note it decided on, a person's note corrected, a review entry for each curated note or learned standard it contests |

Every document the review writes is signed `author: mercury-review` in its frontmatter, over whatever author it had: that's how you tell, from the file alone, a text the model wrote from one a person wrote.

### What raw/ takes

A `raw/` entry is a Markdown file (`.md`, the only kind the triage lists) of at most 64 KiB, about 16k tokens, so the model reads it whole in one pass. A larger one is left in `raw/` and logged (`raw/<path> is over the raw/ limit`), never triaged in part, and `mfw vault write-raw` refuses it up front. Splitting a long document into several notes is a feature of its own, not there yet.

### Locked notes

A locked note is one only people change. A note is locked when:

- its frontmatter says `locked: true`. On a curated document, whoever curates the wiki sets it, with `mfw vault lock`/`unlock` or by hand. On a person's note, the person asks the model and `write_file` sets it;
- it's under one of the `locked` paths of the config, whatever its frontmatter says. A learned standard (`curated/standards/`, written by counting) is locked only this way, and then the corrections plugin doesn't rewrite it either.

The review's `write_curated` and `delete_curated` refuse a locked document. When one looks wrong, or contradicts another document, the review opens a review entry on it instead (its `flag_for_review` tool), and a person decides. `promote_note` never carries a person's lock into `curated/`.

### Review entries

`review/` holds one entry per curated note a person has to decide on, `review/<id>.md`, the id being the note's path with its folders joined by `--` (`curated--release` for `curated/release.md`). An entry says which note, why in a sentence, the turns behind it when there are any, and the text proposed in the note's place when there is one. A new entry on the same note replaces the open one. `mfw vault review list` and `show` read them, `accept` and `reject` decide them, each in one commit:

| Kind | Opened by | `accept` | `reject` |
|---|---|---|---|
| `locked` | the review, on a locked note it would have changed | the proposed text, still locked | nothing changes, the entry just closes |
| `curated` | the dreaming pass, on a curated note it contests | the proposed text, `status: validated` | the text kept, `status: validated` |
| `standard` | the dreaming pass, on a learned standard that keeps failing | the standard deleted, with its index line (the corrections plugin learns it again) | `status: validated` |

### A note's frontmatter

What the wiki's own writers put at the top of a note, besides `type`:

| Field | On | Set by |
|---|---|---|
| `author` | curated documents | `mfw vault write-curated --author`; `mercury-review` when the nightly review wrote it |
| `last_updated` | curated documents, a person's notes | whoever wrote it, as a date |
| `locked: true` | curated documents, a person's notes | `mfw vault lock` or by hand; `write_file` when the person asks |
| `status` | any note | the dreaming pass (`unverified`, `verified`, `contested`); `validated` when a person decided a review entry on it |
| `validated_at` | any note | when a person decided a review entry on it |
| `verified_at`, `evidence` | any note | the dreaming pass: when it last decided on the note, and the turns its verdict rests on |

A learned standard and a person's `inferred/` notes also carry `source`, `confidence`, `derived_from` and `last_reviewed`, written by the consolidation (see [What the memory writes here](#what-the-memory-writes-here)). A note the review or the consolidation rewrites, or a person's note the model rewrites with `write_file`, loses its `status`: new text, nothing decided on it yet.

## Dreaming

With `review: { dreaming: {} }` the nightly run ends with a check of the notes against what happened when they were used. Nothing else checks them: in a conversation the model takes what it finds in the wiki as true, and the triage takes `raw/` as given.

**Which notes.** A note is *used* when the model opened it with `read_file` in a turn and the read worked: the plugin records every such read from each turn's record (`onTurnRecord`), in its data folder (`ctx.dataDir`). Each night the pass checks:

- every curated note and every person's note (`personal/notes/`) used since the last pass. A note nobody opened has no new conversation to be checked against, so it's left for a night when someone uses it;
- every curated document the review wrote (`author: mercury-review`) that has no status yet, even unused, so what came from `raw/` is looked at the same night.

What it counts lives in the plugin's data folder, which must be on a volume like the rest of Mercury's state: `uses.jsonl` (the uses waiting for the next pass, moved to `uses.taking.jsonl` and `uses.taken.jsonl` while a pass works on them) and `dreaming.json` (the counts of each note). Without a data folder, or without a conversation store, the log says `dreaming is off` and why, and nothing is recorded; a note the pass couldn't check says `dreaming: <note> not checked` and why.

It leaves alone locked notes, notes `contested` and waiting for a person, a person's `inferred/` notes (facts about them, already promoted by counting) and the operator's turns. It reads the conversations from the instance's conversation store, so with dreaming on the wiki needs one (`needs: ["conversationStore"]`): an app without it stops at startup.

**How each kind is decided.** *k* is `dreaming.k`, 3 by default; conversations are counted once each, however many of their turns used the note.

| Note | Who decides | What it looks at | What can come of it |
|---|---|---|---|
| a learned standard (`curated/standards/`) | code, never the model | the later calls to the standard's tool in each turn that read it: one worked counts for, all failed counts against | `verified` at *k* conversations for and none against; `contested` at *k* against, with a `standard` review entry |
| a person's note | the model | that person's turns that read it, and the few messages after each | rewritten when a turn contradicts it (`status: verified`, no review entry: the note is theirs); `verified` at *k* conversations with nothing against |
| any other curated note | the model | everyone's turns that read it, and what it knows of the world | `contested` when a turn contradicts it or it's plainly false, with a `curated` review entry carrying the text proposed in its place; `verified` at *k* conversations with nothing against |
| a document the review wrote, unused | the model | what it knows of the world only | `contested` when it's plainly false, `unverified` otherwise |

The model's own knowledge only ever contests, and only something plainly false about the world in general, never the team's own conventions, projects, people or tools, which it can't know. A review entry's reason is a sentence of the model's own, with no quotes from the conversations: a curated note's entry is read by a person who wasn't in them.

A note a person **validated** (by deciding its review entry) is never made `verified` by counting; it's contested again only by *k* conversations against it after their decision. A note whose text changed, whoever changed it, is counted from scratch. A note that fails (the model or the store away) is logged, kept for the next night, and the others go on.

**What a person sees.** The model reads the statuses in the frontmatter, and with dreaming on it's told that a note `contested` or `unverified` may be wrong, and to say so when its answer relies on one. Review entries wait in `mfw vault review list`.

**An example, from `raw/` to a validated note.**

1. Monday, someone runs `mfw vault write-raw raw/release.md` with "We tag the release, then merge it."
2. Monday night, the triage makes it `curated/release.md`, `author: mercury-review`. The dreaming pass, last in the same run, finds it unchecked, sees nothing plainly false in it, and marks it `status: unverified`.
3. Tuesday, Anna asks how to release. The model reads `curated/release.md`, answers, and says the note isn't verified yet. Anna replies that it's the other way round: merge first, then tag.
4. Tuesday night, the note was used, so the pass checks it against Anna's turn and the messages after it. The turn contradicts it: the note becomes `status: contested`, and `review/curated--release.md` opens with the reason and "Merge first, then tag." as the proposed text.
5. Wednesday, the model still reads the note, but says it's contested. Luca runs `mfw vault review show curated--release`, agrees, and runs `mfw vault review accept curated--release`: the note gets the new text, `status: validated`, and the entry is gone.
6. From then on the note is contested again only if *k* conversations after Wednesday contradict it.

**When to leave it off.** Every instance has the three passes of the review; the dreaming pass is worth it only when someone will act on what it finds:

| Situation | Why dreaming doesn't help, or does harm |
|---|---|
| the wiki is a copy of an official source (docs synced from Confluence or a repository) | the truth is in the source: a contested note is fixed there, not in the wiki, and review entries are only noise (lock the copied folders with `locked`, or leave dreaming off) |
| a small team with someone looking after the notes | people notice by themselves, and review entries are extra work |
| little GPU, nights already full | every used note that isn't a standard is at least one call to the model |
| privacy or internal rules | for a common note the model reads several people's conversations together; it writes no quotes from them, but some may not want them read together at all |
| a model too small | wrong contests, and a person's notes rewritten worse than they were |

## What the memory writes here

The plugin carries `notes`, on the same vault, which the memory plugins are given: `memory({ wiki: teamWiki })` and `corrections({ wiki: teamWiki })`.

- `promoteFact(key, topic, cluster)` makes a fact about a person their note `personal/inferred/<topic>.md`, `promoteCorrection(tool, topic, cluster)` a rule about a tool `curated/standards/<tool>-<topic>.md`, which everyone reads. `cluster(limit)` hands over the last occurrences of that topic the plugin kept. The value that becomes the note is decided by counting, never by the model: the one most frequent among the last three occurrences, with no tie, and only when it has more occurrences behind it than the note already there (`derived_from`, in its frontmatter). Each says what it did: `written`, `no-dominant`, `kept-incumbent`, or `locked` for a standard under one of the `locked` paths, which it leaves alone.
- `facts(key)` reads a person's `inferred/` notes back: topic, text, and when the occurrences behind each were found.

The memory plugin declared with the wiki is what writes there; the wiki itself never does.

## Maintenance

`mfw vault` lists, reads, searches and writes the vault from outside the agent, decides its review entries and locks its curated documents, in a one-off container on its volume (see the [CLI's README](../../../apps/cli/README.md#mfw-vault-command)). It runs this package's `vault-cli.ts`, and walks the whole vault. It finds the vault through `WIKI_VAULT_PATH` only, so an app passing `vaultPath` sets the variable to the same folder for it.
