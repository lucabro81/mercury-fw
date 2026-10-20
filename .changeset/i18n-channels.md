---
"@mercury-fw/channel-types": minor
"@mercury-fw/confirm-engine": minor
"@mercury-fw/core": minor
"@mercury-fw/channel-http": minor
"@mercury-fw/channel-google-chat": minor
---

The channels' texts come out in the person's language too, and the language their client asks for counts. Channel contract version 6:

- The person's language is the one they saved, else the one their client asks for, else the app's default. The HTTP channel passes on the request's `Accept-Language` header (what browsers send), Google Chat the language of the person's Chat client when its event carries one (`InboundTurn.languageHint`). Someone the agent refuses gets it too.
- A channel declares its own texts in English in `messages`, under its name (`google-chat.`, `http.`), checked like a plugin's; it gets them through `ctx.i18n.forRequest(principal, hint)`.
- The replies to a confirmation are the core's, in the person's language: `ctx.confirm` returns `{ text, resume? }` and `ctx.resolveConfirmation` the outcome with its `text`. A confirmed action reads "Confirmed and done." instead of its raw result as JSON. `confirmReply`, `RESUME_AFTER_CONFIRM` and `PENDING_CONFIRMATION_NOTE` are gone from the contract, and `tryConfirm` from `@mercury-fw/confirm-engine` (`resolveConfirmation` reports the outcome; the core words it).
- The stand-in for an answer the model didn't write because the turn staged an action (`core.pending.note`, "Action pending, waiting for confirmation.") is no longer streamed as text: `finalize(text, { pendingNote })` says the text begins with it, and channels drop it through that, never by comparing text.
- A plain staging's single choice has an empty label: each channel words its own button ("Confirm" on Google Chat, in the person's language). `loginLinkText(login, t)` takes the person's texts.
- HTTP: `Accept-Language` on `/turn`, `/confirm` and `/login/callback`; `Content-Language` on the responses of `/turn` and `/confirm`; the `final` event carries `pendingNote`; the login page reads in the browser's language.
- Google Chat: the cards' titles, status lines and confirm button are `google-chat.*` texts; the client's `common.userLocale` is the hint.

The texts that were in Italian (the cards, the replies to a confirmation, the pending note) are now English by default. An app that wants them in Italian adds their keys to `locales/it.json` (`core.pending.note`, `core.confirm.*`, `core.login.link*`, `google-chat.*`, `http.*`; the log lists the missing ones at startup). A UI on the HTTP channel can hide the pending note through `final`'s `pendingNote`, and words the button of a choice with an empty label itself. A channel written for contract 5 isn't loaded by this core, and the log says why: rebuild it against `CHANNEL_API_VERSION` 6.
