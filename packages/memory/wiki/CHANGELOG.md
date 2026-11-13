# @mercury-fw/wiki

## 0.75.0

### Minor Changes

- bcabfa1: - new `@mercury-fw/memory`: `memory({ wiki?, captureEvery? })`, episodic summaries every few messages and on a session's close, facts promoted to the person's `inferred/` notes through the wiki, every turn's messages indexed for `recall_verbatim`, a `session` layer with the last conversation's recap, `summariesOf` for `conversationWindow({ earlier })`; `needs: ["vectorIndex", "embedding"]`; in the framework's fixed group
  - new `@mercury-fw/corrections`: `corrections({ wiki })`, a failed command and a later one that worked in the same turn, kept in `tool_corrections` and promoted to `curated/standards/<tool>-<topic>.md`; `needs: ["vectorIndex", "embedding"]`; in the framework's fixed group
  - `wiki()` returns `notes`: `promoteFact`, `promoteCorrection`, `facts`, the deterministic consolidation into the vault
  - background jobs named `memory:capture`, `memory:archive-index`, `corrections:correction`
  - `SESSION_CAPTURE_MESSAGE_THRESHOLD` is read by `memory()`
  - **Breaking:** the core keeps no long-term memory: no episodic summaries, no facts, no corrections, no `recall_verbatim`, no recap of the last session: declare `memory()` and `corrections()`
  - **Breaking:** no `memory.capture`, `memory.consolidate`, `memory.correction` events in the traces, and no "Noting down something important" status while a conversation is captured; `core.status.remembering`, `core.status.capture-detail`, `core.status.correction-detail` are gone
  - `mfw create` declares `memory({ wiki: teamWiki })` (in `plugins` and in the `default` profile's `layers`), `corrections({ wiki: teamWiki })`, and `conversationWindow({ earlier: longTermMemory })`
  - **Migration:** `bun add @mercury-fw/memory @mercury-fw/corrections`, then in `mercury.config.ts` add `import { memory } from "@mercury-fw/memory";`, `import { corrections } from "@mercury-fw/corrections";`, `const longTermMemory = memory({ wiki: teamWiki });` (declared before the conversation), `conversationWindow({ earlier: longTermMemory })`, `longTermMemory` and `corrections({ wiki: teamWiki })` in `plugins`, and `longTermMemory` in the `layers` of each context profile that should start with the last conversation's recap
  - **Migration:** an app's language files translating `core.status.remembering`, `core.status.capture-detail`, `core.status.correction-detail` can drop them
- 2df58af: - new `@mercury-fw/wiki`: `wiki({ vaultPath?, review? })`, the vault (`WIKI_VAULT_PATH` by default), the tools `list_files`, `read_file`, `grep`, `write_file`, `promote_note`, a `session` layer with `index.md`, the nightly review at `review.at` (`"03:00"` by default, `false` for none); in the framework's fixed group
  - the nightly review's passes are `background.job` events `wiki:review-raw`, `wiki:review-index`, `wiki:review-contradictions`; no `review.pass` event
  - the wiki tools' status lines are `wiki.status.read`, `wiki.status.write`, `wiki.status.search`; `core.status.wiki-read`, `core.status.wiki-write`, `core.status.searching` are gone
  - **Breaking:** the core keeps no wiki: no wiki tools, no wiki text in the system prompt, no wiki index in the primer, no nightly review, `WIKI_VAULT_PATH` no longer required: declare `wiki()`
  - the confirmation notes are kept in the data folder, `confirmations/<key>/<token>.md`; the ones in the vault (`users/<key>/confirmations/`) are copied there at the first start, from `WIKI_VAULT_PATH`
  - an old vault layout's `inferred/confirmations/` stays where it is
  - `resolve_reference` is the core's, offered on every turn
  - **Breaking:** `ChannelHostReads` has no `wikiList`, `wikiRead`, `wikiGrep`
  - **Breaking:** `channel-http` has no `GET /wiki/list`, `/wiki/read`, `/wiki/grep`
  - **Breaking:** confirm-engine's `WriteConfirmationNote` takes no path, and `ConfirmDeps` and the staging deps have no `vaultPath`
  - `mfw create` declares `const teamWiki = wiki()`, in `plugins` and in the `default` profile's `layers`
  - `mfw vault` runs `@mercury-fw/wiki`'s CLI
  - **Migration:** keep `WIKI_VAULT_PATH` set on the first start, so the confirmation notes are copied from the vault
  - **Migration:** an app's language files translating `core.status.wiki-read`, `core.status.wiki-write`, `core.status.searching` translate `wiki.status.read`, `wiki.status.write`, `wiki.status.search` instead
  - **Migration:** `bun add @mercury-fw/wiki`, then in `mercury.config.ts` add `import { wiki } from "@mercury-fw/wiki";`, `const teamWiki = wiki();`, `teamWiki` in `plugins`, and `teamWiki` in the `layers` of each context profile that should read the wiki's index

### Patch Changes

- Updated dependencies [21716af]
- Updated dependencies [4d0c1ed]
- Updated dependencies [bf7b7f3]
  - @mercury-fw/plugin-types@0.75.0
