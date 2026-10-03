---
"@mercury-fw/channel-types": minor
"@mercury-fw/core": minor
"@mercury-fw/channel-google-chat": minor
"@mercury-fw/channel-http": minor
---

- A turn carries a `Principal` (the person behind it and the provider that vouched for them) instead of the opaque `userId` and `wikiUserId`; the core derives every per-person id from it, with the same values as before.
- `CHANNEL_API_VERSION` is 2: a channel written for version 1 is refused at load.
- Google Chat builds the principal from the message sender; the terminal and the HTTP channel send one nobody vouched for, so their sessions stay out of episodic memory as before.
- The first-party channels declare their channel api version as a literal, so an older channel can't claim a newer contract it doesn't implement.
