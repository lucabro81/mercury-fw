# @mercury-fw/context-files

## 0.79.0

### Minor Changes

- 7faedea: - new `@mercury-fw/context-files`: `contextFiles()`, a profile's `conversation` keeping long tool outputs, older messages (`overflow: "files"`) and, with `layers: true`, the session layers in files of its data folder, read with `read_context_file` and `search_context_files`; a conversation's files kept until unused for `cleanup.afterDays` (7)
  - `@mercury-fw/conversation-window` exports `createWindow`, `messageChars`, `createSummarizer`, `readTail`, `resumeConversation`, `resumeBudget`, `createRecallToolCalls`, `RECALL_PROMPT_FRAGMENT`
  - `Conversation.pastCall(call, shown)`: gets what the core would show of the call

### Patch Changes

- Updated dependencies [7faedea]
  - @mercury-fw/conversation-window@0.79.0
  - @mercury-fw/plugin-types@0.79.0
