---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/cli-engine": minor
"@mercury-fw/plugin-jira": patch
---

- The model is told, at the end of every prompt, which lists it already showed in the conversation: each one's ref and the command that built it, never the list itself. It can show one again with `present`, or run the command again for fresh data, instead of retyping it from memory.
- A list shown in a conversation stays available for `present` as long as the conversation, previously five minutes, at most the ten most recent per conversation.
- `stashDisplay` takes an optional label, and the cli-engine passes the command that built the list with its number of items.
- The jira skill points to the lists already shown, and keeps a new search for fresh data.
