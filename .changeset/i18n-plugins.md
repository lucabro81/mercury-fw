---
"@mercury-fw/plugin-types": minor
"@mercury-fw/cli-engine": minor
"@mercury-fw/formatter": minor
"@mercury-fw/core": minor
"@mercury-fw/plugin-jira": minor
"@mercury-fw/plugin-bitbucket": minor
"@mercury-fw/plugin-atlassian-admin": minor
"@mercury-fw/plugin-zitadel": minor
"@mercury-fw/plugin-web-search": minor
---

The plugins' texts a person sees come out in their language, like the core's. Plugin contract version 5:

- A plugin declares its texts in English in `messages`, every key under its own name (`web-search.choice.once`); the core refuses a plugin with a key outside it, and the app's language files translate them. The startup log names the missing keys of the plugins too.
- While a turn runs, a plugin gets the texts of its person as `t`: in `SessionToolContext.t`, as the second argument of a status describer (`toolStatusDescribers`, `StatusDescriber`), the third of a post-processor (`CliPostProcessor`), and in a post-turn guard, whose `statusLabel` is now `(t) => string` and whose `run` gets `t` as its third argument. `Messages`, `Params` and `Translate` are part of the contract.
- The default status line of a CLI command is the core's `core.status.command` ("Running jira issue search"), and an unreadable command's is `core.status.command-unknown`.
- The formatter hands a rule `t` as its second argument, and an `empty` text can be `(t) => string`; existing rules keep working as they are.
- Web search: the two choices ("Only this time", "Always for \<host\>"), the status lines and the sources heading ("Sources") are `web-search.*` texts, English by default; a list of sources the model writes under the heading in the person's language, or the English one, is still replaced by the plugin's.

A plugin written for contract 4 isn't loaded by this core, and the log says why: rebuild it against `PLUGIN_API_VERSION` 5 (a status describer, a guard's `statusLabel` and `run`, a post-processor take the new `t`). An app that wants the web search and status lines back in Italian adds their keys to `locales/it.json` (the log lists the missing ones at startup).
