# @mercury-fw/plugin-web-search

## 0.1.2

### Patch Changes

- edfebb5: - `@mercury-fw/plugin-web-search`: an answer no longer lists its sources twice. When the model writes its own list of sources at the end of the answer, the plugin's `Fonti:` list replaces it, and `web_fetch`'s description tells the model the pages it reads are listed for it.
  - `@mercury-fw/channel-google-chat`: once a choice on a confirmation card is taken, the card shows it ("Scelto: …") instead of the buttons. A click that confirms nothing (expired, or someone else's in a shared space) leaves the card as it is.
  - `@mercury-fw/channel-types`: `confirmReply(outcome)`, the reply to each confirmation outcome, for a channel that resolves a token through `resolveConfirmation`.
  - `@mercury-fw/confirm-engine`: `tryConfirm` answers with `confirmReply`, same texts as before.

## 0.1.1

### Patch Changes

- 4431285: - plugin-web-search README: the minimum core (0.53), the Italian labels the person reads, where a person's list lives and how to edit it, and a config example matching the app `mfw create` writes.
  - channel-google-chat README: the confirmation card has a button per choice, and a choice whose result goes back to the model runs the turn again.

## 0.1.0

### Minor Changes

- c83b129: - New plugin `@mercury-fw/plugin-web-search`: `web_search` through a backend package of the app's choice, and `web_fetch` to read a page and hand the model its title and text.
  - A page is read right away only on a host the instance allows (`allowedHosts`) or the person allowed; for any other host the person chooses between reading that page only and allowing the host for good (their own list, kept in the plugin's folder), and the page goes back to the model either way.
  - Internal addresses are never read, redirects included, and only HTML and plain text are, up to 2 MB and 20,000 characters.
  - An answer built on pages ends with the list of the pages read (`Fonti:`).
  - A post-turn guard's `shouldRun` gets the turn's steps as a second argument.
