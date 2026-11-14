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
| `review` | When the nightly review runs: `{ at, timeZone }`, `at` a time of day (`"HH:MM"`) and `timeZone` an IANA name, the instance's (`i18n.timeZone`) when left out. Every day at `"03:00"` when left out, `false` for none. A time or a time zone that can't be stops the app at startup. |
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

Every day at the time `review` says, the background model goes through the vault in three passes, each a job of its own on Mercury's queue (the traces show them as `background.job` events named `wiki:review-raw`, `wiki:review-index`, `wiki:review-contradictions`). A pass that fails is logged and the others go on. A day the agent wasn't running isn't made up.

It's easy to lose track of who touches what, so here's the vault from the review's side first:

| Folder | Who writes it | Who reads it |
|---|---|---|
| `curated/` | people (`mfw vault write-curated`, git on the volume), `promote_note` once confirmed, the nightly review | everyone's model, the nightly review |
| `curated/standards/<tool>-<topic>.md` | the corrections plugin, by counting (see [What the memory writes here](#what-the-memory-writes-here)) | everyone's model, the nightly review |
| `personal/notes/` | the model, for that person | that person's model |
| `personal/inferred/` | the memory plugin, by counting | that person's model |
| `raw/` | people (`mfw vault write-raw`) | the nightly review |
| `review/` | the nightly review | people (`mfw vault review`); never the model |
| `index.md` | the nightly review | everyone's model, at the start of a session |

The review never sees anyone's area, only `curated/` and `raw/`. Then the passes, in the order they run:

| Pass | Reads | Writes | Leaves behind |
|---|---|---|---|
| **raw triage**, when `raw/` has something | `raw/`, `curated/` | `curated/`, `index.md`, `raw/` (deleting) | each entry merged into a document, promoted to a new one, or discarded, then deleted from `raw/` |
| **index**, when a document isn't in `index.md` | `curated/`, `index.md` | `index.md`, `curated/` (cross-links) | a line in the index for each orphan |
| **contradictions**, every time | `curated/` | `curated/`, `index.md` | contradictions fixed and cross-links added where it's confident, duplicates deleted |

Every document the review writes is signed `author: mercury-review` in its frontmatter, over whatever author it had: that's how you tell, from the file alone, a text the model wrote from one a person wrote.

### What raw/ takes

A `raw/` entry is a Markdown file (`.md`, the only kind the triage lists) of at most 64 KiB, about 16k tokens, so the model reads it whole in one pass. A larger one is left in `raw/` and logged (`raw/<path> is over the raw/ limit`), never triaged in part, and `mfw vault write-raw` refuses it up front. Splitting a long document into several notes is a feature of its own, not there yet.

### Locked notes

A locked note is one only people change. A note is locked when:

- its frontmatter says `locked: true`. On a curated document, whoever curates the wiki sets it, with `mfw vault lock`/`unlock` or by hand. On a person's note, the person asks the model and `write_file` sets it;
- it's under one of the `locked` paths of the config, whatever its frontmatter says. A learned standard (`curated/standards/`, written by counting) is locked only this way.

The review's `write_curated` and `delete_curated` refuse a locked document. When one looks wrong, or contradicts another document, the review opens a review entry on it instead (its `flag_for_review` tool), and a person decides. `promote_note` never carries a person's lock into `curated/`.

### Review entries

`review/` holds one entry per curated note a person has to decide on, `review/<id>.md`, the id being the note's path with its folders joined by `--` (`curated--release` for `curated/release.md`). An entry says which note, why in a sentence, the turns behind it when there are any, and the text proposed in the note's place when there is one. A new entry on the same note replaces the open one. `mfw vault review list` and `show` read them, `accept` and `reject` decide them, each in one commit:

| Kind | Opened by | `accept` | `reject` |
|---|---|---|---|
| `locked` | the review, on a locked note it would have changed | the proposed text, still locked | nothing changes, the entry just closes |
| `curated` | nothing yet (a check of the notes against the conversations they were used in, in a later release) | the proposed text, `status: validated` | the text kept, `status: validated` |
| `standard` | nothing yet (the same later check, on a learned standard that keeps failing) | the standard deleted, with its index line (the corrections plugin learns it again) | `status: validated` |

### A note's frontmatter

What the wiki's own writers put at the top of a note, besides `type`:

| Field | On | Set by |
|---|---|---|
| `author` | curated documents | `mfw vault write-curated --author`; `mercury-review` when the nightly review wrote it |
| `last_updated` | curated documents, a person's notes | whoever wrote it, as a date |
| `locked: true` | curated documents, a person's notes | `mfw vault lock` or by hand; `write_file` when the person asks |
| `status` | any note | `validated` when a person decided a review entry on it; `unverified`, `verified` and `contested` are kept for the later check of the notes, nothing writes them yet |
| `validated_at` | any note | when a person decided a review entry on it |
| `verified_at`, `evidence` | any note | kept for the same later check (when it last looked, the turns its verdict rests on); nothing writes them yet |

A learned standard and a person's `inferred/` notes also carry `source`, `confidence`, `derived_from` and `last_reviewed`, written by the consolidation (see [What the memory writes here](#what-the-memory-writes-here)). A note the review or the consolidation rewrites loses its `status`: new text, nothing decided on it yet.

## What the memory writes here

The plugin carries `notes`, on the same vault, which the memory plugins are given: `memory({ wiki: teamWiki })` and `corrections({ wiki: teamWiki })`.

- `promoteFact(key, topic, cluster)` makes a fact about a person their note `personal/inferred/<topic>.md`, `promoteCorrection(tool, topic, cluster)` a rule about a tool `curated/standards/<tool>-<topic>.md`, which everyone reads. `cluster(limit)` hands over the last occurrences of that topic the plugin kept. The value that becomes the note is decided by counting, never by the model: the one most frequent among the last three occurrences, with no tie, and only when it has more occurrences behind it than the note already there (`derived_from`, in its frontmatter). Each says what it did: `written`, `no-dominant`, `kept-incumbent`.
- `facts(key)` reads a person's `inferred/` notes back: topic, text, and when the occurrences behind each were found.

The memory plugin declared with the wiki is what writes there; the wiki itself never does.

## Maintenance

`mfw vault` lists, reads, searches and writes the vault from outside the agent, decides its review entries and locks its curated documents, in a one-off container on its volume (see the [CLI's README](../../../apps/cli/README.md#mfw-vault-command)). It runs this package's `vault-cli.ts`, and walks the whole vault. It finds the vault through `WIKI_VAULT_PATH` only, so an app passing `vaultPath` sets the variable to the same folder for it.
