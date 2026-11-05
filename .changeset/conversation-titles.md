---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/channel-http": minor
---

- conversations get a title, generated from the first question and its answer after the first turn the person wrote; kept in the Qdrant collection `conversation_titles` (`QDRANT_TITLES_COLLECTION`)
- channel contract: optional `ctx.conversations` with `rename`, the title the person chose, never replaced by a generated one
- `GET /conversations` and `GET /conversation` carry `title` once a conversation has one
- `PATCH /conversation?id=<conversationId>` with `{ title }` renames one of the caller's conversations
