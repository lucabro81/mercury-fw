---
"@mercury-fw/channel-types": minor
"@mercury-fw/confirm-engine": minor
"@mercury-fw/core": minor
"@mercury-fw/channel-http": minor
"@mercury-fw/channel-google-chat": minor
---

Isolation between the people an agent talks to.

- The core keeps one identity per person, `<provider>:<id>`, so two providers issuing the same id are two people. Memory, the conversation archive, the tool log and pending confirmations are keyed on it.
- The wiki has a common area (`curated/`) everyone reads and an area per person (`users/<key>/`), which the model sees as `personal/`. Listing, reading and grepping reach the common area and the caller's own area, nothing else.
- Breaking: the model's `write_file` writes only under `personal/notes/`. The new `promote_note` tool copies one of the person's notes into `curated/`, and only once they confirm it with the token.
- A confirmation can only be confirmed by whoever staged it, in the same session. Its note is written once, in the person's area: a staged note no longer stays "pending" after it's resolved, for ids such as Google Chat's `users/<n>`.
- Breaking, `@mercury-fw/channel-types`: channel contract 3. `confirm` and `resolveConfirmation` take the caller's `Principal`, and so does every read getter except `manifest` and `health`. Channels written for contract 2 are refused.
- `@mercury-fw/confirm-engine`: the store's `stage`, `take` and `pending` take the owner's key.
- Breaking, `@mercury-fw/channel-http`: every read route returns only the caller's data. `/conversation?id=` takes one of the caller's `conversationId`s and `/conversations` lists them by `conversationId`. `/wiki/read` answers `404` outside what the caller can see, and `/memory/scroll` answers `400` for a collection that isn't kept per person.
- `@mercury-fw/channel-google-chat`: on channel contract 3.
- At startup, an instance's existing data moves to the new layout. Google Chat and terminal notes go into their areas, and Qdrant's ids go onto the new keys. Ids that don't say which provider they came from are left in place and logged.
- `mfw vault read` refuses a path outside the vault.
