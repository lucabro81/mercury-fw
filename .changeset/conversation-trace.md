---
"@mercury-fw/core": minor
"@mercury-fw/confirm-engine": minor
"@mercury-fw/channel-http": patch
---

- the verbatim archive keeps, with each answer, what its turn showed besides the text, as `trace`: reasoning blocks, tool status lines with their outcome, confirmations staged, logins asked for (no tokens, no login links)
- a stopped turn's interrupted answer keeps its `trace` up to the stop
- an answer that only staged an action keeps its `pendingNote`
- a resolved confirmation is archived in its conversation as a message with `confirmation: { id, command, status, choice? }`, its `content` the reply the person got
- `GET /conversation` returns `trace`, `pendingNote` and `confirmation`; `recall_verbatim` and a conversation rebuilt from the archive leave them out
- `ConfirmDeps.onResolved` (`@mercury-fw/confirm-engine`): told how a staged action was resolved
- `openapi.yaml`: `Message.trace`, `Message.pendingNote`, `Message.confirmation`, `TraceEntry`
