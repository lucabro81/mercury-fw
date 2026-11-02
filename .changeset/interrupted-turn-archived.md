---
"@mercury-fw/core": minor
"@mercury-fw/channel-http": patch
---

- a cancelled turn is archived: the person's message, then an answer marked `interrupted`
- `reads.conversation`: an interrupted answer comes with `interrupted: true` and an empty `content`
- `reads.conversations`: the preview skips an interrupted answer
- `GET /conversation` documents `interrupted` on `Message`
