---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/kit": minor
---

- `context` in `mercury.config.ts`: profiles of plugins' layers with a budget in characters, `default` required, `assign` by role
- plugin contract: `context: { scope, build }` in `build()`'s contributions, a `"session"` layer built once per session and person and kept in the system prompt, a `"turn"` layer in front of the person's message for that call only
- a layer runs only for people its plugin is offered to
- the start stops on a layer naming a plugin not in `plugins` or one with no layer, a plugin listed twice in a profile, or a budget that isn't a whole number
- `context.assembled` in the traces: the profile, and per layer the characters and blocks added, dropped or why it was skipped
