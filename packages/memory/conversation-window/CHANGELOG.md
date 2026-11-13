# @mercury-fw/conversation-window

## 0.75.0

### Minor Changes

- 4d0c1ed: - new `@mercury-fw/conversation-window`: `conversationWindow({ maxChars?, overflow?, reopen?, earlier? })`, the conversation a context profile keeps, with `recall_tool_calls`
  - **Breaking:** the core keeps no conversation of its own: a profile without `conversation` reads only the current message. **Migration:** `bun add @mercury-fw/conversation-window`, add `const conversation = conversationWindow();` (from `@mercury-fw/conversation-window`), put `conversation` in `plugins` and `context: { profiles: { default: { conversation, layers: [], budget: { maxChars: 8000 } } } }` in `mercury.config.ts` (or `conversation` in each profile you already have); without a `conversationStore`, use `conversationWindow({ reopen: false })`, or the app doesn't start
  - **Breaking:** `SESSION_RESUME_MAX_CHARS` is gone. **Migration:** `conversationWindow({ reopen: { maxChars } })`
  - `recall_tool_calls` and its prompt text come from `conversation-window`; its status line is `conversation-window.status.recall`, and `core.status.memory` and `core.status.call-history` are gone
  - a summary that fails no longer fails the turn: the window stays as it was and the next message tries again
  - `Conversation.addUserMessage` and `addAssistantMessage` may resolve to a `CompressionReport`, recorded as `history.compressed`
  - `formatTurnStamp` in the plugin contract
  - `mfw create`: new apps declare `conversationWindow()` and name it in the `default` profile
  - `HTTP_SURFACE_RESUME_MAX_CHARS` unset: the conversation window's own budget

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
- Updated dependencies [21716af]
- Updated dependencies [4d0c1ed]
- Updated dependencies [bf7b7f3]
  - @mercury-fw/plugin-types@0.75.0
