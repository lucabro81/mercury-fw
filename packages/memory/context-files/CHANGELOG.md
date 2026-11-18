# @mercury-fw/context-files

## 0.80.0

### Patch Changes

- @mercury-fw/plugin-types@0.80.0
- @mercury-fw/conversation-window@0.80.0

## 0.79.2

### Patch Changes

- 5a8e9a6: - README links to the documentation site's Context strategies section
  - @mercury-fw/plugin-types@0.79.2
  - @mercury-fw/conversation-window@0.79.2

## 0.79.1

### Patch Changes

- 3ff4e18: - a moved tool output is written one value per line with its path, a long string as a block of its own lines
- 63b8f83: - a conversation with its own view of tool outputs (`Conversation.toolOutput`, as `contextFiles()`) no longer breaks every turn that calls a tool (fixes `undefined is not an object (evaluating 'call of step.toolCalls')`)
  - `contextFiles()`: a conversation nobody vouched for (the terminal's) starts without the files of the previous one
  - @mercury-fw/plugin-types@0.79.1
  - @mercury-fw/conversation-window@0.79.1

## 0.79.0

### Minor Changes

- 7faedea: - new `@mercury-fw/context-files`: `contextFiles()`, a profile's `conversation` keeping long tool outputs, older messages (`overflow: "files"`) and, with `layers: true`, the session layers in files of its data folder, read with `read_context_file` and `search_context_files`; a conversation's files kept until unused for `cleanup.afterDays` (7)
  - `@mercury-fw/conversation-window` exports `createWindow`, `messageChars`, `createSummarizer`, `readTail`, `resumeConversation`, `resumeBudget`, `createRecallToolCalls`, `RECALL_PROMPT_FRAGMENT`
  - `Conversation.pastCall(call, shown)`: gets what the core would show of the call

### Patch Changes

- Updated dependencies [7faedea]
  - @mercury-fw/conversation-window@0.79.0
  - @mercury-fw/plugin-types@0.79.0
