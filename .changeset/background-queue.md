---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/kit": minor
"@mercury-fw/cli": minor
---

- the work nobody waits on (titles, memory captures, corrections, the archive's index, the nightly review) waits for the model: it runs only in the requests the turns leave free of the model's `capacity`, one model call at a time, titles, corrections and the archive's index first
- `ollamaModel(name, { backgroundSlots })`: how many of the model's requests that work may take at once; 1 when left out, below `capacity` when it's above 1
- a turn's corrections, its threshold capture and its message's indexing no longer hold the conversation's next turn
- a model of a plugin's own (`ctx.modelFor`) goes through the same queue
- `background.job` in the traces: each piece of that work that called a model, its models, model calls, time waited, time taken, and whether it was done, failed or dropped at stop
- `mfw create`: `backgroundSlots` read from `OLLAMA_BACKGROUND_SLOTS`, in the env example
- **Migration:** to set it from the environment, add `backgroundSlots: envNumber("OLLAMA_BACKGROUND_SLOTS"),` to the turn model's `ollamaModel(...)` in `mercury.config.ts`
