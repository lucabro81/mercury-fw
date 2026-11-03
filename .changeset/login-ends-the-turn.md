---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/channel-http": minor
"@mercury-fw/channel-google-chat": minor
---

- a step whose tool asks the person to log in ends the turn: no further tool calls
- the turn's text closes with `core.login.note`, naming the services to log in to
- `detectLoginRequests(step)` in `@mercury-fw/channel-types`: every login a step asks for, one per link
- HTTP channel: one `login` event per service the step asks for
- Google Chat: one login card per service the step asks for
- **Migration:** apps with their own locale files add `core.login.note` (`{services}`) to each non-English one
