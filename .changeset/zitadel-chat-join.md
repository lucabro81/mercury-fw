---
"@mercury-fw/plugin-zitadel": minor
"@mercury-fw/channel-google-chat": minor
---

A Google Chat sender is recognised as their ZITADEL user.

- `channel-google-chat` passes the sender's email on as a claim (`claims.email`), on messages and on card clicks, when Google vouches for it: a person's, never a bot's.
- `zitadelDirectory` resolves a Google Chat sender to the one active ZITADEL user with that email, verified, whose identity provider links include the sender's own Google account. Anyone else on Chat stays unknown and can link their account with a code.
