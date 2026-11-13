---
"@mercury-fw/wiki": minor
"@mercury-fw/core": minor
"@mercury-fw/confirm-engine": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/channel-http": minor
"@mercury-fw/cli": minor
---

- new `@mercury-fw/wiki`: `wiki({ vaultPath?, review? })`, the vault (`WIKI_VAULT_PATH` by default), the tools `list_files`, `read_file`, `grep`, `write_file`, `promote_note`, a `session` layer with `index.md`, the nightly review at `review.at` (`"03:00"` by default, `false` for none); in the framework's fixed group
- the nightly review's passes are `background.job` events `wiki:review-raw`, `wiki:review-index`, `wiki:review-contradictions`; no `review.pass` event
- the wiki tools' status lines are `wiki.status.read`, `wiki.status.write`, `wiki.status.search`
- **Breaking:** the core keeps no wiki: no wiki tools, no wiki text in the system prompt, no wiki index in the primer, no nightly review, `WIKI_VAULT_PATH` no longer required: declare `wiki()`
- the confirmation notes are kept in the data folder, `confirmations/<key>/<token>.md`; the ones in the vault (`users/<key>/confirmations/`) are copied there once at startup
- `resolve_reference` is the core's, offered on every turn
- facts and corrections stay in the vector index without being written as wiki notes, and the primer has no "Known facts"
- **Breaking:** `ChannelHostReads` has no `wikiList`, `wikiRead`, `wikiGrep`
- **Breaking:** `channel-http` has no `GET /wiki/list`, `/wiki/read`, `/wiki/grep`
- **Breaking:** confirm-engine's `WriteConfirmationNote` takes no path, and `ConfirmDeps` and the staging deps have no `vaultPath`
- `mfw create` declares `const teamWiki = wiki()`, in `plugins` and in the `default` profile's `layers`
- `mfw vault` runs `@mercury-fw/wiki`'s CLI
- **Migration:** `bun add @mercury-fw/wiki`, then in `mercury.config.ts` add `import { wiki } from "@mercury-fw/wiki";`, `const teamWiki = wiki();`, `teamWiki` in `plugins`, and `teamWiki` in the `layers` of each context profile that should read the wiki's index
