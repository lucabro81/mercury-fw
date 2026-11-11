---
"@mercury-fw/core": minor
---

- add `traces` to `mercury.config.ts`: `{ sink, level? }`, `level` `meta` (default) or `args`; nothing is recorded without it
- events for every turn (`turn.start`, `turn.end`), model step (`model.step`, with Ollama's load, prefill and generation times), tool call, confirmation, history compression and post-turn guard
- events for memory (`memory.capture`, `memory.consolidate`, `memory.correction`), titles, the nightly review, closed sessions
- events at startup (`system.start`, `system.channels`, with the plugins and channels left out and why) and for fail-soft errors (`system.error`, `system.recovered`)
- the person and the session are pseudonymous in every event, from a secret generated in `.mercury/trace-secret`
- each archived message carries the `turnId` of its turn
- `composeMercury` returns `tracer`; `loadChannels` takes an optional `tracer`
- export `pseudonymOf`, `MercuryTraces`, `TraceLevel`, `Tracer`
