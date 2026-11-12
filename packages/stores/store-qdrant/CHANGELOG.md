# @mercury-fw/store-qdrant

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
