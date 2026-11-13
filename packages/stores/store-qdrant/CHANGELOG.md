# @mercury-fw/store-qdrant

## 0.75.0

### Patch Changes

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
- Updated dependencies [bf7b7f3]
- Updated dependencies [2df58af]
  - @mercury-fw/channel-types@0.75.0

## 0.74.0

### Patch Changes

- Updated dependencies [9c78729]
  - @mercury-fw/channel-types@0.74.0

## 0.73.0

### Minor Changes

- fb1f30a: - conversation-store contract: `ConversationStorePlugin`, `ConversationStore`, `StoredMessage`, `StoredTitle`, `CONVERSATION_STORE_API_VERSION`
  - `conversationStore` in `mercury.config.ts`: where every conversation's messages and title are kept
  - **Breaking:** without `conversationStore` nothing is archived: no reopened or listed conversations, no titles, no `recall_verbatim`
  - `qdrantConversations()` in `@mercury-fw/store-qdrant`: messages in `conversation_messages` (`QDRANT_MESSAGES_COLLECTION`), titles in `conversation_titles` (`QDRANT_TITLES_COLLECTION`); on start, copies the messages of `verbatim_archive` into `conversation_messages` once, marking the copy done only when all are in
  - `@mercury-fw/core` no longer depends on `@qdrant/js-client-rest` and no longer reads `QDRANT_URL`
  - **Breaking:** `GET /health` (HTTP): `conversationStoreReachable` and `vectorIndexReachable` (`null` when not declared) instead of `qdrantReachable`
  - **Breaking:** channel contract 7: `ChannelHostReads.conversation`, `conversations` and `memoryScroll` optional, given only with a conversation store / a vector index; channels written for contract 6 are refused
  - `channel-http`, `channel-google-chat`: channel contract 7, framework 0.73 or later
  - `channel-http`: `/conversation`, `/conversations` (`GET`, `PATCH`) only with a conversation store, `/memory/scroll` only with a vector index; `404` otherwise
  - `system.start` trace event: `conversationStore` (`declared`, `active`)
  - `mfw create`: new apps declare `conversationStore: qdrantConversations()`
  - **Migration:** in `mercury.config.ts`, import `qdrantConversations` from `@mercury-fw/store-qdrant` and add `conversationStore: qdrantConversations(),`; upgrade `@mercury-fw/channel-http` and `@mercury-fw/channel-google-chat` with the framework; a UI reading `qdrantReachable` from `/health` reads the two new fields
- b634bd1: - vector-index contract: `VectorIndexPlugin`, `VectorIndex`, `VectorPoint`, `VectorSpaceSpec`, `VectorWhere`, `VECTOR_INDEX_API_VERSION`
  - `vectorIndex` in `mercury.config.ts`: where episodes, semantic facts, procedural corrections and `recall_verbatim`'s search are kept
  - **Breaking:** without `vectorIndex` there is no long-term memory: no conversation summaries, no corrections, no `recall_verbatim` (tool and prompt), idle conversations closed without a summary
  - new package `@mercury-fw/store-qdrant`: `qdrantIndex()`, Qdrant at `QDRANT_URL`, each space the collection of the same name or the one its `QDRANT_*_COLLECTION` names
  - the memory's vector length comes from the embedding model at startup; `QDRANT_*_VECTOR_SIZE` no longer read
  - `GET /memory/scroll` (HTTP) takes the index's space name (`episodic_memory`, `semantic_facts`, `verbatim_archive`), not the `QDRANT_*_COLLECTION` name
  - `system.start` trace event: `vectorIndex` (`declared`, `active`)
  - `mfw memory` runs the memory CLI of `@mercury-fw/store-qdrant`
  - `mfw create`: new apps declare `vectorIndex: qdrantIndex()` and depend on `@mercury-fw/store-qdrant`
  - **Migration:** add `@mercury-fw/store-qdrant` to the app's dependencies, at the framework's version; in `mercury.config.ts`, `import { qdrantIndex } from "@mercury-fw/store-qdrant";` and `vectorIndex: qdrantIndex(),`; `QDRANT_*_VECTOR_SIZE` can go from `.env`

### Patch Changes

- Updated dependencies [fb1f30a]
- Updated dependencies [b634bd1]
  - @mercury-fw/channel-types@0.73.0
