---
"@mercury-fw/formatter": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/core": minor
"@mercury-fw/cli-engine": minor
---

- `formatterPlugin` renders the `display` of every tool a plugin contributes, typed tools included (`{ ok: true, …, display }`)
- formatter rule `{ item, empty?, always: true }`: that kind is shown after the answer without `present`, the model gets `shown: true` next to its `displayRef`
- `ToolDisplay.always`
- the core strips `display` from every plugin tool's result and stashes it, a typed tool's too
- stashed list labels: the tool name, its input and the item count
- a failed or cancelled turn's displays are no longer appended to the next answer
- `present` is offered with any plugin tool
- **Breaking:** `createCliTool` no longer takes `stashDisplay` and returns the post-processor's `display` as it is: drop the option
- **Breaking:** a hand-written `DisplayHandler` returns `{ text, always? }` instead of a string: wrap the text
