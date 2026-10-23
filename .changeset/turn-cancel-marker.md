---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
---

A turn its channel cancels isn't an answer anymore.

- An aborted model call no longer leaves half an answer in the conversation history: the person's message stays, followed by a note that the answer was stopped, so the next message keeps its context. The same goes for a turn the stall watchdog stops.
- A cancelled turn (its `abortSignal` aborted) is never finalized, run through the post-turn guards or archived, and it resolves instead of throwing; the sink is still released with `dispose`. Before, the AI SDK returned what it had and the turn delivered it as the answer.
- Channel contract: the `abortSignal` doc says what a cancelled turn does. No change in shape, the contract version stays 6.
