---
"@mercury-fw/core": patch
"@mercury-fw/context-files": patch
---

- a conversation with its own view of tool outputs (`Conversation.toolOutput`, as `contextFiles()`) no longer breaks every turn that calls a tool (fixes `undefined is not an object (evaluating 'call of step.toolCalls')`)
- `contextFiles()`: a conversation nobody vouched for (the terminal's) starts without the files of the previous one
