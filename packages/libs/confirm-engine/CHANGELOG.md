# @mercury-fw/confirm-engine

## 0.63.0

### Patch Changes

- @mercury-fw/plugin-types@0.63.0
- @mercury-fw/channel-types@0.63.0

## 0.62.0

### Patch Changes

- @mercury-fw/plugin-types@0.62.0
- @mercury-fw/channel-types@0.62.0

## 0.61.0

### Patch Changes

- Updated dependencies [1e7fdeb]
  - @mercury-fw/channel-types@0.61.0
  - @mercury-fw/plugin-types@0.61.0

## 0.60.0

### Patch Changes

- @mercury-fw/plugin-types@0.60.0
- @mercury-fw/channel-types@0.60.0

## 0.59.2

### Patch Changes

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.
- Updated dependencies [f631dd5]
  - @mercury-fw/channel-types@0.59.2
  - @mercury-fw/plugin-types@0.59.2

## 0.59.1

### Patch Changes

- @mercury-fw/plugin-types@0.59.1
- @mercury-fw/channel-types@0.59.1

## 0.59.0

### Patch Changes

- Updated dependencies [7c9a038]
  - @mercury-fw/channel-types@0.59.0
  - @mercury-fw/plugin-types@0.59.0

## 0.58.0

### Patch Changes

- Updated dependencies [e3eb49d]
  - @mercury-fw/channel-types@0.58.0
  - @mercury-fw/plugin-types@0.58.0

## 0.57.0

### Patch Changes

- @mercury-fw/plugin-types@0.57.0
- @mercury-fw/channel-types@0.57.0

## 0.56.0

### Patch Changes

- Updated dependencies [1126106]
  - @mercury-fw/channel-types@0.56.0
  - @mercury-fw/plugin-types@0.56.0

## 0.55.0

### Patch Changes

- Updated dependencies [eac72fa]
  - @mercury-fw/plugin-types@0.55.0
  - @mercury-fw/channel-types@0.55.0

## 0.54.0

### Minor Changes

- e00ff73: The channels' texts come out in the person's language too, and the language their client asks for counts. Channel contract version 6:

  - The person's language is the one they saved, else the one their client asks for, else the app's default. The HTTP channel passes on the request's `Accept-Language` header (what browsers send), Google Chat the language of the person's Chat client when its event carries one (`InboundTurn.languageHint`). Someone the agent refuses gets it too.
  - A channel declares its own texts in English in `messages`, under its name (`google-chat.`, `http.`), checked like a plugin's; it gets them through `ctx.i18n.forRequest(principal, hint)`.
  - The replies to a confirmation are the core's, in the person's language: `ctx.confirm` returns `{ text, resume? }` and `ctx.resolveConfirmation` the outcome with its `text`. A confirmed action reads "Confirmed and done." instead of its raw result as JSON. `confirmReply`, `RESUME_AFTER_CONFIRM` and `PENDING_CONFIRMATION_NOTE` are gone from the contract, and `tryConfirm` from `@mercury-fw/confirm-engine` (`resolveConfirmation` reports the outcome; the core words it).
  - The stand-in for an answer the model didn't write because the turn staged an action (`core.pending.note`, "Action pending, waiting for confirmation.") is no longer streamed as text: `finalize(text, { pendingNote })` says the text begins with it, and channels drop it through that, never by comparing text.
  - A plain staging's single choice has an empty label: each channel words its own button ("Confirm" on Google Chat, in the person's language). `loginLinkText(login, t)` takes the person's texts.
  - HTTP: `Accept-Language` on `/turn`, `/confirm` and `/login/callback`; `Content-Language` on the responses of `/turn` and `/confirm`; the `final` event carries `pendingNote`; the login page reads in the browser's language.
  - Google Chat: the cards' titles, status lines and confirm button are `google-chat.*` texts; the client's `common.userLocale` is the hint when the event carries it.
  - The terminal's replies to a confirmation read in the terminal person's language, like its other lines.

  The texts that were in Italian (the cards, the replies to a confirmation, the pending note) are now English by default. An app that wants them in Italian adds their keys to `locales/it.json` (`core.pending.note`, `core.confirm.*`, `core.login.link*`, `google-chat.*`, `http.*`; the log lists the missing ones at startup). A UI on the HTTP channel can hide the pending note through `final`'s `pendingNote`, and words the button of a choice with an empty label itself. A channel written for contract 5 isn't loaded by this core, and the log says why: rebuild it against `CHANNEL_API_VERSION` 6.

### Patch Changes

- Updated dependencies [e00ff73]
- Updated dependencies [5015642]
  - @mercury-fw/channel-types@0.54.0
  - @mercury-fw/plugin-types@0.54.0

## 0.53.2

### Patch Changes

- @mercury-fw/plugin-types@0.53.2
- @mercury-fw/channel-types@0.53.2

## 0.53.1

### Patch Changes

- edfebb5: - `@mercury-fw/plugin-web-search`: an answer no longer lists its sources twice. When the model writes its own list of sources at the end of the answer, the plugin's `Fonti:` list replaces it, and `web_fetch`'s description tells the model the pages it reads are listed for it.
  - `@mercury-fw/channel-google-chat`: once a choice on a confirmation card is taken, the card shows it ("Scelto: …") instead of the buttons. A click that confirms nothing (expired, or someone else's in a shared space) leaves the card as it is.
  - `@mercury-fw/channel-types`: `confirmReply(outcome)`, the reply to each confirmation outcome, for a channel that resolves a token through `resolveConfirmation`.
  - `@mercury-fw/confirm-engine`: `tryConfirm` answers with `confirmReply`, same texts as before.
- Updated dependencies [edfebb5]
  - @mercury-fw/channel-types@0.53.1
  - @mercury-fw/plugin-types@0.53.1

## 0.53.0

### Patch Changes

- Updated dependencies [56e4ed5]
- Updated dependencies [c83b129]
  - @mercury-fw/plugin-types@0.53.0
  - @mercury-fw/channel-types@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies [678c1cc]
  - @mercury-fw/plugin-types@0.52.0
  - @mercury-fw/channel-types@0.52.0

## 0.51.0

### Minor Changes

- b2f8cfb: - A confirmation can offer several choices (for example "only this time" / "always for this host"): a plugin tool stages them with the new `stageChoices` of `SessionToolContext`, and gets one token per choice. The person takes one; the others die with it, and they all expire together.
  - The paper-trail note of a group of choices is one, under its first token, and says which choice was taken.
  - `detectPendingConfirmation` returns the `choices` a staging offers; a plain staging is one choice labelled `Conferma`.
  - A confirmed action can hand its result back to the model (`resume` on a choice): instead of showing the person the raw result, the channel resumes the turn and the model answers on it, the result reaching it as the tool result of the call that staged it, never stored in the history.
  - A resumed turn answers the person who confirmed even in a shared space, and the line standing for the confirmation isn't archived as something they said. A result nobody resumes within five minutes (the life of a confirmation token) is forgotten, and a restart loses it.
  - `InboundTurn.resumeAfterConfirm` and `RESUME_AFTER_CONFIRM` (channel contract) carry the resumed turn; `ConfirmOutcome` has a `resume` status.
  - Terminal: every choice is printed on its own line with its token; a confirmation that resumes runs the turn again.
  - Google Chat: the confirmation card has one button per choice; a typed token or a clicked choice that resumes runs the turn again, in the session's queue. The channel now needs channel-types 0.51.0 or later.
  - HTTP: the `pending` event carries `choices`; a token sent to `POST /turn` that resumes streams the model's answer on the same request; `POST /confirm` answers `resume: true`, and `POST /turn { resume: true, conversationId }` runs that turn. The channel now needs channel-types 0.51.0 or later.

### Patch Changes

- Updated dependencies [b2f8cfb]
  - @mercury-fw/plugin-types@0.51.0
  - @mercury-fw/channel-types@0.51.0

## 0.50.4

### Patch Changes

- @mercury-fw/plugin-types@0.50.4
- @mercury-fw/channel-types@0.50.4

## 0.50.3

### Patch Changes

- @mercury-fw/plugin-types@0.50.3
- @mercury-fw/channel-types@0.50.3

## 0.50.2

### Patch Changes

- @mercury-fw/plugin-types@0.50.2
- @mercury-fw/channel-types@0.50.2

## 0.50.1

### Patch Changes

- @mercury-fw/plugin-types@0.50.1
- @mercury-fw/channel-types@0.50.1

## 0.50.0

### Patch Changes

- Updated dependencies [ae495c7]
  - @mercury-fw/plugin-types@0.50.0
  - @mercury-fw/channel-types@0.50.0

## 0.49.1

### Patch Changes

- @mercury-fw/plugin-types@0.49.1
- @mercury-fw/channel-types@0.49.1

## 0.49.0

### Patch Changes

- Updated dependencies [b7438a6]
  - @mercury-fw/channel-types@0.49.0
  - @mercury-fw/plugin-types@0.49.0

## 0.48.0

### Patch Changes

- Updated dependencies [62bb3a3]
  - @mercury-fw/plugin-types@0.48.0
  - @mercury-fw/channel-types@0.48.0

## 0.47.1

### Patch Changes

- @mercury-fw/plugin-types@0.47.1
- @mercury-fw/channel-types@0.47.1

## 0.47.0

### Patch Changes

- Updated dependencies [3d73e59]
  - @mercury-fw/channel-types@0.47.0
  - @mercury-fw/plugin-types@0.47.0

## 0.46.1

### Patch Changes

- @mercury-fw/plugin-types@0.46.1
- @mercury-fw/channel-types@0.46.1

## 0.46.0

### Patch Changes

- Updated dependencies [4184ea6]
  - @mercury-fw/channel-types@0.46.0
  - @mercury-fw/plugin-types@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [812c9c5]
  - @mercury-fw/channel-types@0.45.0
  - @mercury-fw/plugin-types@0.45.0

## 0.44.1

### Patch Changes

- @mercury-fw/plugin-types@0.44.1
- @mercury-fw/channel-types@0.44.1

## 0.44.0

### Patch Changes

- Updated dependencies [2c63bbf]
  - @mercury-fw/channel-types@0.44.0
  - @mercury-fw/plugin-types@0.44.0

## 0.43.0

### Patch Changes

- @mercury-fw/plugin-types@0.43.0
- @mercury-fw/channel-types@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [a7f2f13]
  - @mercury-fw/channel-types@0.42.0
  - @mercury-fw/plugin-types@0.42.0

## 0.41.0

### Patch Changes

- @mercury-fw/plugin-types@0.41.0
- @mercury-fw/channel-types@0.41.0

## 0.40.0

### Patch Changes

- Updated dependencies [0739f77]
  - @mercury-fw/plugin-types@0.40.0
  - @mercury-fw/channel-types@0.40.0

## 0.39.0

### Patch Changes

- @mercury-fw/plugin-types@0.39.0
- @mercury-fw/channel-types@0.39.0

## 0.38.1

### Patch Changes

- @mercury-fw/plugin-types@0.38.1
- @mercury-fw/channel-types@0.38.1

## 0.38.0

### Patch Changes

- @mercury-fw/plugin-types@0.38.0
- @mercury-fw/channel-types@0.38.0

## 0.37.0

### Patch Changes

- @mercury-fw/plugin-types@0.37.0
- @mercury-fw/channel-types@0.37.0

## 0.36.0

### Minor Changes

- 521db42: Isolation between the people an agent talks to.

  - The core keeps one identity per person, `<provider>:<id>`, so two providers issuing the same id are two people. Memory, the conversation archive, the tool log and pending confirmations are keyed on it.
  - The wiki has a common area (`curated/`) everyone reads and an area per person (`users/<key>/`), which the model sees as `personal/`. Listing, reading and grepping reach the common area and the caller's own area, nothing else.
  - Breaking: the model's `write_file` writes only under `personal/notes/`. The new `promote_note` tool copies one of the person's notes into `curated/`, and only once they confirm it with the token.
  - A confirmation can only be confirmed by whoever staged it, in the same session. Its note is written once, in the person's area: a staged note no longer stays "pending" after it's resolved, for ids such as Google Chat's `users/<n>`.
  - Breaking, `@mercury-fw/channel-types`: channel contract 3. `confirm` and `resolveConfirmation` take the caller's `Principal`, and so does every read getter except `manifest` and `health`. Channels written for contract 2 are refused.
  - `@mercury-fw/confirm-engine`: the store's `stage`, `take` and `pending` take the owner's key.
  - Breaking, `@mercury-fw/channel-http`: every read route returns only the caller's data. `/conversation?id=` takes one of the caller's `conversationId`s and `/conversations` lists them by `conversationId`. `/wiki/read` answers `404` outside what the caller can see, and `/memory/scroll` answers `400` for a collection that isn't kept per person.
  - `@mercury-fw/channel-google-chat`: on channel contract 3.
  - At startup, an instance's existing data moves to the new layout. Google Chat and terminal notes go into their areas, and Qdrant's ids go onto the new keys. Ids that don't say which provider they came from are left in place and logged.
  - `mfw vault read` refuses a path outside the vault.
  - The admin panel's wiki box edits the common area with the operator's tools (list, read, grep, `write_curated`), the same the nightly review uses.

### Patch Changes

- Updated dependencies [521db42]
  - @mercury-fw/channel-types@0.36.0
  - @mercury-fw/plugin-types@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [8d3e5af]
  - @mercury-fw/channel-types@0.35.0
  - @mercury-fw/plugin-types@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [8bed46b]
  - @mercury-fw/channel-types@0.34.0
  - @mercury-fw/plugin-types@0.34.0

## 0.33.0

### Patch Changes

- @mercury-fw/plugin-types@0.33.0
- @mercury-fw/channel-types@0.33.0

## 0.32.0

### Patch Changes

- @mercury-fw/plugin-types@0.32.0
- @mercury-fw/channel-types@0.32.0

## 0.31.1

### Patch Changes

- @mercury-fw/plugin-types@0.31.1
- @mercury-fw/channel-types@0.31.1

## 0.31.0

### Patch Changes

- @mercury-fw/plugin-types@0.31.0
- @mercury-fw/channel-types@0.31.0

## 0.30.0

### Patch Changes

- @mercury-fw/plugin-types@0.30.0
- @mercury-fw/channel-types@0.30.0

## 0.29.4

### Patch Changes

- @mercury-fw/plugin-types@0.29.4
- @mercury-fw/channel-types@0.29.4

## 0.29.3

### Patch Changes

- @mercury-fw/plugin-types@0.29.3
- @mercury-fw/channel-types@0.29.3

## 0.29.2

### Patch Changes

- @mercury-fw/plugin-types@0.29.2
- @mercury-fw/channel-types@0.29.2

## 0.29.1

### Patch Changes

- @mercury-fw/plugin-types@0.29.1
- @mercury-fw/channel-types@0.29.1

## 0.29.0

### Patch Changes

- @mercury-fw/plugin-types@0.29.0
- @mercury-fw/channel-types@0.29.0

## 0.28.4

### Patch Changes

- @mercury-fw/plugin-types@0.28.4
- @mercury-fw/channel-types@0.28.4

## 0.28.3

### Patch Changes

- @mercury-fw/plugin-types@0.28.3
- @mercury-fw/channel-types@0.28.3

## 0.28.2

### Patch Changes

- @mercury-fw/plugin-types@0.28.2
- @mercury-fw/channel-types@0.28.2

## 0.28.1

### Patch Changes

- @mercury-fw/plugin-types@0.28.1
- @mercury-fw/channel-types@0.28.1

## 0.28.0

### Patch Changes

- @mercury-fw/plugin-types@0.28.0
- @mercury-fw/channel-types@0.28.0

## 0.27.1

### Patch Changes

- @mercury-fw/plugin-types@0.27.1
- @mercury-fw/channel-types@0.27.1

## 0.27.0

### Patch Changes

- @mercury-fw/plugin-types@0.27.0
- @mercury-fw/channel-types@0.27.0

## 0.26.0

### Patch Changes

- @mercury-fw/plugin-types@0.26.0
- @mercury-fw/channel-types@0.26.0

## 0.25.1

### Patch Changes

- @mercury-fw/plugin-types@0.25.1
- @mercury-fw/channel-types@0.25.1

## 0.25.0

### Patch Changes

- @mercury-fw/plugin-types@0.25.0
- @mercury-fw/channel-types@0.25.0
