# @mercury-fw/plugin-web-search

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
