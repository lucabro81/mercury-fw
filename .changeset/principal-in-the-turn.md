---
"@mercury-fw/channel-types": minor
"@mercury-fw/core": minor
"@mercury-fw/channel-google-chat": minor
"@mercury-fw/channel-http": minor
---

- A turn carries a `Principal` (the person behind it and the provider that vouched for them) instead of the opaque `userId` and `wikiUserId`; the core derives every per-person id from it.
- Episodic memory follows the principal, not the channel: a session is captured whenever a provider vouched for the person. Google Chat keeps the ids it had; the terminal and the HTTP channel (until it authenticates its callers) send a principal nobody vouched for, so they stay out of episodic memory as before.
- The HTTP channel accepts a `conversationId` (on `/turn`, `/confirm` and `/conversation`) only made of letters, digits, `-` and `_`, up to 128 characters, and answers `400` otherwise: a client-chosen id can no longer reach another user's wiki notes, forge log lines or break the turn.
- The model's wiki read tools refuse a per-user id that isn't one path segment, as writes already did.
- `CHANNEL_API_VERSION` is 2: a channel written for version 1 is refused at load.
- The first-party channels declare their channel api version as a literal, so an older channel can't claim a newer contract it doesn't implement.
