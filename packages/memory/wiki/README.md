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

## The vault

At startup the plugin makes the vault a git repository with its folders if it isn't one yet (an empty volume on the first start), and every write is a commit, so the history of every note is the vault's own. The folders:

- `curated/`, the team's common knowledge (conventions, docs, project status), which everyone reads;
- `users/<key>/`, one area per person (`<key>` is Mercury's identity for them, `<provider>:<id>`, encoded), which the model sees as `personal/`: `personal/notes/` is what it writes for that person, `personal/inferred/` what Mercury learned about them;
- `raw/`, material pasted in as it is, waiting for the nightly review to sort it into `curated/`;
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
| `write_file` | Writes a note below `personal/notes/`, replacing the whole file. |
| `promote_note` | Copies one of the person's notes into `curated/`, once they confirm it. |

The model reads what they're for in the system prompt, and when to look in the wiki first: before trying a tool or answering from what it knows, for anything about the team's documentation, projects and conventions. Their status lines are under the `wiki.status.read`, `wiki.status.write` and `wiki.status.search` keys.

## The nightly review

Every day at the time `review` says, the background model goes through the vault in three passes, each a job of its own on Mercury's queue (the traces show them as `background.job` events named `wiki:review-raw`, `wiki:review-index`, `wiki:review-contradictions`):

- it sorts what's in `raw/` into `curated/`, when there's anything;
- it brings `index.md` in line with `curated/`, when a document isn't in it;
- it looks for contradictions and missing cross-links between documents, every time.

A pass that fails is logged and the others go on. A day the agent wasn't running isn't made up.

## Maintenance

`mfw vault` lists, reads, searches and writes the vault from outside the agent, in a one-off container on its volume (see the [CLI's README](../../../apps/cli/README.md#mfw-vault-command)). It runs this package's `vault-cli.ts`, and walks the whole vault.
