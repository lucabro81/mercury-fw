---
"@mercury-fw/conversation-window": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/core": minor
"@mercury-fw/cli": minor
"@mercury-fw/channel-http": patch
---

- new `@mercury-fw/conversation-window`: `conversationWindow({ maxChars?, overflow?, reopen?, earlier? })`, the conversation a context profile keeps, with `recall_tool_calls`
- **Breaking:** the core keeps no conversation of its own: a profile without `conversation` reads only the current message. **Migration:** `bun add @mercury-fw/conversation-window`, add `const conversation = conversationWindow();` (from `@mercury-fw/conversation-window`), put `conversation` in `plugins` and `context: { profiles: { default: { conversation, layers: [], budget: { maxChars: 8000 } } } }` in `mercury.config.ts` (or `conversation` in each profile you already have); without a `conversationStore`, use `conversationWindow({ reopen: false })`, or the app doesn't start
- **Breaking:** `SESSION_RESUME_MAX_CHARS` is gone. **Migration:** `conversationWindow({ reopen: { maxChars } })`
- `recall_tool_calls` and its prompt text come from `conversation-window`; its status line is `conversation-window.status.recall`, and `core.status.memory` and `core.status.call-history` are gone
- a summary that fails no longer fails the turn: the window stays as it was and the next message tries again
- `Conversation.addUserMessage` and `addAssistantMessage` may resolve to a `CompressionReport`, recorded as `history.compressed`
- `formatTurnStamp` in the plugin contract
- `memory.capture` events no longer have `trigger: "compress"`
- `mfw create`: new apps declare `conversationWindow()` and name it in the `default` profile
- `HTTP_SURFACE_RESUME_MAX_CHARS` unset: the conversation window's own budget
