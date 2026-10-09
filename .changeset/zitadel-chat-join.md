---
"@mercury-fw/plugin-zitadel": minor
"@mercury-fw/channel-google-chat": minor
"@mercury-fw/cli": patch
---

A Google Chat sender is recognised as their ZITADEL user.

- `channel-google-chat` passes the sender's email on as a claim (`claims.email`), on messages and on card clicks, when Google vouches for it: a person's (`HUMAN`) only.
- `zitadelDirectory` resolves a Google Chat sender to the one active ZITADEL user with that email, verified, whose links to the Google identity provider (`ZITADEL_GOOGLE_IDP_ID`, new and optional) include the sender's own Google account. Without that variable nobody is recognised from Chat. Anyone else on Chat stays unknown and can link their account with a code.
- `mfw create` lists `ZITADEL_GOOGLE_IDP_ID` in the env example of an app with the ZITADEL directory.
