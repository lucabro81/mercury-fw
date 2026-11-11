---
"@mercury-fw/channel-types": minor
"@mercury-fw/core": minor
"@mercury-fw/store-qdrant": minor
"@mercury-fw/cli": minor
"@mercury-fw/kit": patch
"@mercury-fw/channel-http": minor
"@mercury-fw/channel-google-chat": minor
---

- conversation-store contract: `ConversationStorePlugin`, `ConversationStore`, `StoredMessage`, `StoredTitle`, `CONVERSATION_STORE_API_VERSION`
- `conversationStore` in `mercury.config.ts`: where every conversation's messages and title are kept
- **Breaking:** without `conversationStore` nothing is archived: no reopened or listed conversations, no titles, no `recall_verbatim`
- `qdrantConversations()` in `@mercury-fw/store-qdrant`: messages in `conversation_messages` (`QDRANT_MESSAGES_COLLECTION`), titles in `conversation_titles` (`QDRANT_TITLES_COLLECTION`); on start, copies the messages of `verbatim_archive` it doesn't hold yet
- `@mercury-fw/core` no longer depends on `@qdrant/js-client-rest` and no longer reads `QDRANT_URL`
- **Breaking:** `GET /health` (HTTP): `conversationStoreReachable` and `vectorIndexReachable` (`null` when not declared) instead of `qdrantReachable`
- **Breaking:** channel contract 7: `ChannelHostReads.conversation`, `conversations` and `memoryScroll` optional, given only with a conversation store / a vector index; channels written for contract 6 are refused
- `channel-http`, `channel-google-chat`: channel contract 7, framework 0.73 or later
- `channel-http`: `/conversation`, `/conversations` (`GET`, `PATCH`) only with a conversation store, `/memory/scroll` only with a vector index; `404` otherwise
- `system.start` trace event: `conversationStore` (`declared`, `active`)
- `mfw create`: new apps declare `conversationStore: qdrantConversations()`
- **Migration:** in `mercury.config.ts`, import `qdrantConversations` from `@mercury-fw/store-qdrant` and add `conversationStore: qdrantConversations(),`; upgrade `@mercury-fw/channel-http` and `@mercury-fw/channel-google-chat` with the framework; a UI reading `qdrantReachable` from `/health` reads the two new fields
