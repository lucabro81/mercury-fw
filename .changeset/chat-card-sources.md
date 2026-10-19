---
"@mercury-fw/plugin-web-search": patch
"@mercury-fw/channel-google-chat": patch
"@mercury-fw/channel-types": patch
"@mercury-fw/confirm-engine": patch
---

- `@mercury-fw/plugin-web-search`: an answer no longer lists its sources twice. When the model writes its own list of sources at the end of the answer, the plugin's `Fonti:` list replaces it, and `web_fetch`'s description tells the model the pages it reads are listed for it.
- `@mercury-fw/channel-google-chat`: once a choice on a confirmation card is taken, the card shows it ("Scelto: …") instead of the buttons. A click that confirms nothing (expired, or someone else's in a shared space) leaves the card as it is.
- `@mercury-fw/channel-types`: `confirmReply(outcome)`, the reply to each confirmation outcome, for a channel that resolves a token through `resolveConfirmation`.
- `@mercury-fw/confirm-engine`: `tryConfirm` answers with `confirmReply`, same texts as before.
