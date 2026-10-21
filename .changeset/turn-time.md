---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/cli": patch
"@mercury-fw/channel-http": minor
"@mercury-fw/channel-google-chat": minor
---

Every turn tells the model when and where the person wrote it.

- Each message reaches the model after a line with the weekday, date, time and time zone it was written in (`[Wednesday 2026-10-21 14:32 Europe/Rome]`), and the system prompt says what that line is. The conversation's archive and what a UI shows of it keep the message as written.
- A resumed conversation's messages come back stamped from the archive's timestamps.
- The Layer 1 summary keeps when things were said; the episodic summary quotes a date only from those lines, never guessing one. The semantic-fact extractor and the capture card's preview leave the line out.
- The time zone, always an IANA name (`Europe/Rome`), is the one the person saved, else the one their client is in when the channel passes it on, else the new `i18n.timeZone` in `mercury.config.ts`, else the machine's. A `timeZone` that isn't a zone's name stops the start.
- The person saves theirs by telling the assistant (the new `set_time_zone` tool), or from a channel's settings.
- Channel contract: `InboundTurn.timeZoneHint`, and `ctx.settings.setTimeZone` for a channel with a settings area; `reads.me` also returns the saved `timeZone`. Both are optional additions: the contract version stays 6.
- HTTP channel: the `X-Time-Zone` header on `POST /turn` (allowed by CORS), `timeZone` in `GET /me`, and `PATCH /me` with `{ timeZone }` to save it. Needs the framework at 0.56 or later; an older core ignores the header and offers no `PATCH /me`.
- Google Chat channel: the client's time zone (`common.timeZone`), when the event carries it, on messages and on the turn a click resumes.

To set a default for an app's people, add `timeZone: "Europe/Rome"` (their zone) to `i18n` in `mercury.config.ts`; without it the machine's zone is used, often UTC inside a container.
