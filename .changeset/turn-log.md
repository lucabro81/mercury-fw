---
"@mercury-fw/core": patch
---

- Every turn is logged: when it starts, when it ends (time, steps, tool calls, how much reasoning and answer text), when it fails or is cancelled, and every minute while it is still running. A turn with no tool calls, or one stuck in its reasoning, used to leave no trace.
