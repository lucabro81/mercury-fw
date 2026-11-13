---
"@mercury-fw/plugin-types": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/core": minor
"@mercury-fw/formatter": minor
"@mercury-fw/kit": minor
---

- **Breaking:** plugin contract 7 (`PLUGIN_API_VERSION`): a plugin written for contract 6 isn't loaded, and the log says why: rebuild it against 7
- `Plugin.needs` (`PluginNeed`: `"vectorIndex"`, `"conversationStore"`, `"embedding"`): the plugin's `build()` context gets `vectorIndex`, `conversations`, `embed`; a need the config doesn't declare stops the start, one declared that didn't start leaves the plugin out
- `build()` may return a promise, awaited at startup; one that rejects leaves the plugin out
- every plugin's `build()` context gets `backgroundModel`, `daily(name, { at, timeZone? }, fn)`, `profiles` and `toolLog`
- `daily`: work every day at `"HH:MM"` in `timeZone` or `i18n.timeZone`, run by the service only, a missed day never made up; an `at` or a time zone that can't be stops the start
- `PluginRuntimeContributions.conversation` (`ConversationOwner`, `Conversation`, `ConversationOpen`, `ConversationMessage`): a plugin keeping a session's conversation
- `context.profiles.<p>.conversation`: the plugin keeping that profile's conversations; left out, the core keeps them. One not in `plugins` or keeping none, and a plugin keeping conversations that no profile names, stop the start
- `ContextRequest.reopened`: whether the conversation is one its client reopened
- `VectorIndex`, `ConversationStore`, `StoredMessage`, `StoredTitle`, `CallRecord`, `CallResult`, `TraceEntry`, `ArchivedConfirmation`, `ToolOutcome` are in the plugin contract; `@mercury-fw/channel-types` re-exports them
- **Breaking:** `StoredMessage` lists its fields (`role`, `content`, `displays`, `calls`, `interrupted`, `trace`, `pendingNote`, `confirmation`, `turnId`): a store or a writer adding other fields no longer typechecks
- `formatterPlugin` awaits the plugin's `build()`: its own `build()` returns a promise
- **Migration:** a test calling a plugin's `build()` awaits it: `await plugin.build!(ctx)`
