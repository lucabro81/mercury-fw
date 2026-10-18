---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
---

- A plugin can act as no one (`actsAs: "anyone"`): for a public service with no login, such as web search. It is offered to everyone (still within `access.plugins`), never with a variant acting as Mercury, and the operator gets it under its own names.
- The tools of such a plugin get the turn's `person` all the same (the operator's key on the terminal), to keep what belongs to each person; they can't start a login.
- An older core reads `"anyone"` as `"mercury"`: the plugin is offered only to whoever may make Mercury act as itself.
