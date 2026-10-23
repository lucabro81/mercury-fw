# @mercury-fw/formatter

## 0.59.0

### Patch Changes

- @mercury-fw/plugin-types@0.59.0

## 0.58.0

### Patch Changes

- @mercury-fw/plugin-types@0.58.0

## 0.57.0

### Patch Changes

- @mercury-fw/plugin-types@0.57.0

## 0.56.0

### Patch Changes

- @mercury-fw/plugin-types@0.56.0

## 0.55.0

### Patch Changes

- Updated dependencies [eac72fa]
  - @mercury-fw/plugin-types@0.55.0

## 0.54.0

### Minor Changes

- 5015642: The plugins' texts a person sees come out in their language, like the core's. Plugin contract version 5:

  - A plugin declares its texts in English in `messages`, every key under its own name (`web-search.choice.once`); the core refuses a plugin with a key outside it (and a plugin named `core` or `app`, whose keys are the core's and the app's), and the app's language files translate them. The startup log names the missing keys of the plugins too.
  - While a turn runs, a plugin gets the texts of its person as `t`: in `SessionToolContext.t`, as the second argument of a status describer (`toolStatusDescribers`, `StatusDescriber`), the third of a post-processor (`CliPostProcessor`), and in a post-turn guard, whose `statusLabel` is now `(t) => string` and whose `run` gets `t` as its third argument. `Messages`, `Params` and `Translate` are part of the contract.
  - The default status line of a CLI command is the core's `core.status.command` ("Running jira issue search"), `core.status.command-bare` without a subcommand ("Running jira"), and an unreadable command's is `core.status.command-unknown`. `createCliTool` (`@mercury-fw/cli-engine`) takes the turn's `t` among its options, handed to the post-processor: a CLI plugin passes `sctx.t`; `createCliStatusDescriber`'s describer takes it as its second argument.
  - The formatter hands a rule `t` as its second argument, and an `empty` text can be `(t) => string`; existing rules keep working as they are. An app's own texts go under `app.`, in its `locales/en.json`, which declares them (the startup log no longer lists them as unknown); `mfw create` writes the Jira rule's empty text as `app.jira.no-issues`.
  - Web search: the two choices ("Only this time", "Always for \<host\>"), the status lines and the sources heading ("Sources") are `web-search.*` texts, English by default; a list of sources the model writes under the heading in the person's language, or the English one, is still replaced by the plugin's.

  The first-party plugins released with this change are written for contract 5 and need the core released with it: an older core skips them and says why in the log. A plugin written for contract 4 isn't loaded by this core either, and the log says why: rebuild it against `PLUGIN_API_VERSION` 5 (a status describer, a guard's `statusLabel` and `run`, a post-processor take the new `t`). An app that wants the web search and status lines back in Italian adds their keys to `locales/it.json` (the log lists the missing ones at startup).

### Patch Changes

- Updated dependencies [5015642]
  - @mercury-fw/plugin-types@0.54.0

## 0.53.2

### Patch Changes

- @mercury-fw/plugin-types@0.53.2

## 0.53.1

### Patch Changes

- @mercury-fw/plugin-types@0.53.1

## 0.53.0

### Patch Changes

- Updated dependencies [56e4ed5]
- Updated dependencies [c83b129]
  - @mercury-fw/plugin-types@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies [678c1cc]
  - @mercury-fw/plugin-types@0.52.0

## 0.51.0

### Patch Changes

- Updated dependencies [b2f8cfb]
  - @mercury-fw/plugin-types@0.51.0

## 0.50.4

### Patch Changes

- @mercury-fw/plugin-types@0.50.4

## 0.50.3

### Patch Changes

- @mercury-fw/plugin-types@0.50.3

## 0.50.2

### Patch Changes

- @mercury-fw/plugin-types@0.50.2

## 0.50.1

### Patch Changes

- @mercury-fw/plugin-types@0.50.1

## 0.50.0

### Patch Changes

- Updated dependencies [ae495c7]
  - @mercury-fw/plugin-types@0.50.0

## 0.49.1

### Patch Changes

- @mercury-fw/plugin-types@0.49.1

## 0.49.0

### Patch Changes

- @mercury-fw/plugin-types@0.49.0

## 0.48.0

### Patch Changes

- Updated dependencies [62bb3a3]
  - @mercury-fw/plugin-types@0.48.0

## 0.47.1

### Patch Changes

- @mercury-fw/plugin-types@0.47.1

## 0.47.0

### Patch Changes

- @mercury-fw/plugin-types@0.47.0

## 0.46.1

### Patch Changes

- @mercury-fw/plugin-types@0.46.1

## 0.46.0

### Patch Changes

- @mercury-fw/plugin-types@0.46.0

## 0.45.0

### Patch Changes

- @mercury-fw/plugin-types@0.45.0

## 0.44.1

### Patch Changes

- @mercury-fw/plugin-types@0.44.1

## 0.44.0

### Patch Changes

- @mercury-fw/plugin-types@0.44.0

## 0.43.0

### Patch Changes

- @mercury-fw/plugin-types@0.43.0

## 0.42.0

### Patch Changes

- @mercury-fw/plugin-types@0.42.0

## 0.41.0

### Patch Changes

- @mercury-fw/plugin-types@0.41.0

## 0.40.0

### Patch Changes

- Updated dependencies [0739f77]
  - @mercury-fw/plugin-types@0.40.0

## 0.39.0

### Patch Changes

- @mercury-fw/plugin-types@0.39.0

## 0.38.1

### Patch Changes

- @mercury-fw/plugin-types@0.38.1

## 0.38.0

### Patch Changes

- @mercury-fw/plugin-types@0.38.0

## 0.37.0

### Patch Changes

- @mercury-fw/plugin-types@0.37.0

## 0.36.0

### Patch Changes

- @mercury-fw/plugin-types@0.36.0

## 0.35.0

### Patch Changes

- @mercury-fw/plugin-types@0.35.0

## 0.34.0

### Patch Changes

- @mercury-fw/plugin-types@0.34.0

## 0.33.0

### Patch Changes

- @mercury-fw/plugin-types@0.33.0

## 0.32.0

### Patch Changes

- @mercury-fw/plugin-types@0.32.0

## 0.31.1

### Patch Changes

- @mercury-fw/plugin-types@0.31.1

## 0.31.0

### Patch Changes

- @mercury-fw/plugin-types@0.31.0

## 0.30.0

### Patch Changes

- @mercury-fw/plugin-types@0.30.0

## 0.29.4

### Patch Changes

- @mercury-fw/plugin-types@0.29.4

## 0.29.3

### Patch Changes

- @mercury-fw/plugin-types@0.29.3

## 0.29.2

### Patch Changes

- @mercury-fw/plugin-types@0.29.2

## 0.29.1

### Patch Changes

- @mercury-fw/plugin-types@0.29.1

## 0.29.0

### Patch Changes

- @mercury-fw/plugin-types@0.29.0

## 0.28.4

### Patch Changes

- @mercury-fw/plugin-types@0.28.4

## 0.28.3

### Patch Changes

- @mercury-fw/plugin-types@0.28.3

## 0.28.2

### Patch Changes

- @mercury-fw/plugin-types@0.28.2

## 0.28.1

### Patch Changes

- @mercury-fw/plugin-types@0.28.1

## 0.28.0

### Patch Changes

- @mercury-fw/plugin-types@0.28.0

## 0.27.1

### Patch Changes

- @mercury-fw/plugin-types@0.27.1

## 0.27.0

### Patch Changes

- @mercury-fw/plugin-types@0.27.0

## 0.26.0

### Patch Changes

- @mercury-fw/plugin-types@0.26.0

## 0.25.1

### Patch Changes

- @mercury-fw/plugin-types@0.25.1

## 0.25.0

### Patch Changes

- @mercury-fw/plugin-types@0.25.0
