---
"@mercury-fw/channel-types": minor
"@mercury-fw/core": minor
"@mercury-fw/channel-google-chat": minor
"@mercury-fw/channel-http": minor
---

- A turn carries a `Principal` (the person behind it and the provider that vouched for them) instead of the opaque `userId` and `wikiUserId`; the core derives every per-person id from it.
- Episodic memory follows the principal, not the channel: a session is captured whenever a provider vouched for the person. Google Chat keeps the ids it had; the terminal and the HTTP channel (until it authenticates its callers) send a principal nobody vouched for, so they stay out of episodic memory as before.
- The per-person wiki id is always encoded into a single path segment: an HTTP conversation id with a slash or a space now maps to its encoded form (`a/b` becomes `a%2Fb`) and can no longer reach outside the person's own folder.
- `CHANNEL_API_VERSION` is 2: a channel written for version 1 is refused at load.
- The first-party channels declare their channel api version as a literal, so an older channel can't claim a newer contract it doesn't implement.
