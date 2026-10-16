---
"@mercury-fw/core": patch
"@mercury-fw/cli": patch
---

- A turn on a streaming channel (the HTTP surface) whose model sends nothing for `TURN_STALL_TIMEOUT_MS` (default two minutes, `0` turns it off) is stopped with the error "the model sent nothing for N seconds", logged as stalled. It used to hang, holding its conversation, until the service restarted. A tool that takes long doesn't count: the wait pauses while a tool runs.
- `mfw create` lists `TURN_STALL_TIMEOUT_MS` in a new app's env example.
