---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/kit": minor
---

- plugin contract: `afterTurn(turn)` in `build()`'s contributions, run once a turn ended with an answer, for the plugins offered in it
- plugin contract: `onSessionClose(session)`, run once a quiet session is closed, with its messages, for the plugins offered in its last turn
- `ctx.job(name, urgency, fn)`: a plugin's work nobody waits on, queued for the model like the core's own, `<plugin>:<name>` in the traces
- `ctx.model` goes through the queue: inside `ctx.job` its calls wait for a free slot, during a turn they count as turn work
- `plugin.hook` in the traces: each hook's plugin, time taken, and whether it worked
