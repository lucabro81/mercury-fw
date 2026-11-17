---
"@mercury-fw/context-files": minor
"@mercury-fw/conversation-window": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/core": minor
---

- new `@mercury-fw/context-files`: `contextFiles()`, a profile's `conversation` keeping long tool outputs, older messages (`overflow: "files"`) and, with `layers: true`, the session layers in files of its data folder, read with `read_context_file` and `search_context_files`; a conversation's files kept until unused for `cleanup.afterDays` (7)
- `@mercury-fw/conversation-window` exports `createWindow`, `messageChars`, `createSummarizer`, `readTail`, `resumeConversation`, `resumeBudget`, `createRecallToolCalls`, `RECALL_PROMPT_FRAGMENT`
- `Conversation.pastCall(call, shown)`: gets what the core would show of the call
