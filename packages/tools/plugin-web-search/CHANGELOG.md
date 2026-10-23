# @mercury-fw/plugin-web-search

## 0.4.1

### Patch Changes

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.

## 0.4.0

### Minor Changes

- 00ebab8: The model is told when to search by what the question shows, instead of "what is current or outside what you know", which asked it to know what it doesn't.

  - It searches for what changes over time (news, versions, prices, schedules, who holds a role), for something recent compared with the date on the message, for a precise detail it would otherwise guess, for a name it doesn't recognize, and when asked to look something up or check it.
  - Lasting facts, reasoning, calculations and writing need no search.
  - The plugin's description is now "Searches the web and reads web pages.": when to search is the prompt fragment's.

  "Recent" works best with the framework at 0.56 or later, where every message reaches the model with its date.

## 0.3.0

### Minor Changes

- eac72fa: Every plugin says what it lets the agent do, and the agent can tell. Plugin contract version 6:

  - A plugin declares a `description`: one sentence, in English, for the model, on what it lets the assistant do (`{{assistant}}` stands for its name). How to use it stays in its fragment and skills.
  - The core doesn't load a plugin whose description is missing, blank or more than one line, and the log says why.
  - The system prompt lists the plugins offered to the person, each with its description, right after the persona's identity, and tells the model to answer "what can you do?" from that list. A plugin the person may not use isn't listed; with no plugin offered there's no list.
  - The first-party plugins released with this change carry a description each, are written for contract 6 and need the framework at 0.55.0 or later: the peer range on `@mercury-fw/plugin-types` starts there.

  A plugin written for contract 5 isn't loaded by this core, and the log says why: add a `description` and rebuild it against `PLUGIN_API_VERSION` 6.

## 0.2.0

### Minor Changes

- 5015642: The plugins' texts a person sees come out in their language, like the core's. Plugin contract version 5:

  - A plugin declares its texts in English in `messages`, every key under its own name (`web-search.choice.once`); the core refuses a plugin with a key outside it (and a plugin named `core` or `app`, whose keys are the core's and the app's), and the app's language files translate them. The startup log names the missing keys of the plugins too.
  - While a turn runs, a plugin gets the texts of its person as `t`: in `SessionToolContext.t`, as the second argument of a status describer (`toolStatusDescribers`, `StatusDescriber`), the third of a post-processor (`CliPostProcessor`), and in a post-turn guard, whose `statusLabel` is now `(t) => string` and whose `run` gets `t` as its third argument. `Messages`, `Params` and `Translate` are part of the contract.
  - The default status line of a CLI command is the core's `core.status.command` ("Running jira issue search"), `core.status.command-bare` without a subcommand ("Running jira"), and an unreadable command's is `core.status.command-unknown`. `createCliTool` (`@mercury-fw/cli-engine`) takes the turn's `t` among its options, handed to the post-processor: a CLI plugin passes `sctx.t`; `createCliStatusDescriber`'s describer takes it as its second argument.
  - The formatter hands a rule `t` as its second argument, and an `empty` text can be `(t) => string`; existing rules keep working as they are. An app's own texts go under `app.`, in its `locales/en.json`, which declares them (the startup log no longer lists them as unknown); `mfw create` writes the Jira rule's empty text as `app.jira.no-issues`.
  - Web search: the two choices ("Only this time", "Always for \<host\>"), the status lines and the sources heading ("Sources") are `web-search.*` texts, English by default; a list of sources the model writes under the heading in the person's language, or the English one, is still replaced by the plugin's.

  The first-party plugins released with this change are written for contract 5 and need the core released with it: an older core skips them and says why in the log. A plugin written for contract 4 isn't loaded by this core either, and the log says why: rebuild it against `PLUGIN_API_VERSION` 5 (a status describer, a guard's `statusLabel` and `run`, a post-processor take the new `t`). An app that wants the web search and status lines back in Italian adds their keys to `locales/it.json` (the log lists the missing ones at startup).

### Patch Changes

- 6bb8291: Needs the framework at 0.54.0 or later, the version that brings the contract it's written for (plugin contract 5, channel contract 6): the peer range on `@mercury-fw/plugin-types` and `@mercury-fw/cli-engine` (the plugins) or `@mercury-fw/channel-types` (the channels) starts there.

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
