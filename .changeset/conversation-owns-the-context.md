---
"@mercury-fw/plugin-types": minor
"@mercury-fw/core": minor
---

- `Conversation.toolOutput`: the conversation's own version of each tool result inside a turn, a confirmed action's result included; what's recorded keeps the result itself
- `Conversation.pastCall`: what the model reads of a past call's result
- `Conversation.turnIndex`: text in front of the person's message at every turn, after the turn layers
- `Conversation.placeLayers`: the conversation places the session layers' blocks before the budget; new `LayerBlocks` type
- `tool.view` trace event when the conversation's version of a tool result fails and the model reads the result itself
- `maxSteps` on a context profile: how many steps a turn takes at most, `false` for no limit; 100 when left out
