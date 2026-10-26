# @mercury-fw/core

## 0.61.0

### Minor Changes

- 1e7fdeb: A turn resumed after a confirmation with nothing left to resume says so instead of ending with an empty answer.

  - The core keeps a confirmed action's result for its resumed turn five minutes, and once: later, after a restart, or a second time, the turn now answers "The action was confirmed, but its answer is no longer available: ask me about it again." (`core.resume.gone`), in the person's language, on every channel. The model isn't called and nothing goes into the history.
  - An empty answer to a resumed turn now always comes from the model.

  An app with language files other than English adds `core.resume.gone` to them (the log lists it as missing at startup).

### Patch Changes

- Updated dependencies [1e7fdeb]
  - @mercury-fw/channel-types@0.61.0
  - @mercury-fw/confirm-engine@0.61.0
  - @mercury-fw/plugin-types@0.61.0
  - @mercury-fw/cli-engine@0.61.0
  - @mercury-fw/utils@0.61.0

## 0.60.0

### Patch Changes

- @mercury-fw/plugin-types@0.60.0
- @mercury-fw/channel-types@0.60.0
- @mercury-fw/cli-engine@0.60.0
- @mercury-fw/confirm-engine@0.60.0
- @mercury-fw/utils@0.60.0

## 0.59.2

### Patch Changes

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.
- 3b67dd6: `mfw repl`: the turn's log line (`[turn] done …`) starts on a line of its own instead of landing glued to the end of the answer. The terminal ends the answer's line once the answer is final, and doesn't end it a second time before the prompt, a display or an error. A turn that fails or stalls halfway through an answer still logs right after the partial text.
- Updated dependencies [f631dd5]
  - @mercury-fw/cli-engine@0.59.2
  - @mercury-fw/confirm-engine@0.59.2
  - @mercury-fw/utils@0.59.2
  - @mercury-fw/channel-types@0.59.2
  - @mercury-fw/plugin-types@0.59.2

## 0.59.1

### Patch Changes

- @mercury-fw/plugin-types@0.59.1
- @mercury-fw/channel-types@0.59.1
- @mercury-fw/cli-engine@0.59.1
- @mercury-fw/confirm-engine@0.59.1
- @mercury-fw/utils@0.59.1

## 0.59.0

### Minor Changes

- 7c9a038: - Channels get the framework's version on their runtime context (`ctx.frameworkVersion`, `major.minor.patch`), for a channel that tells people which Mercury they're talking to.

### Patch Changes

- Updated dependencies [7c9a038]
  - @mercury-fw/channel-types@0.59.0
  - @mercury-fw/confirm-engine@0.59.0
  - @mercury-fw/plugin-types@0.59.0
  - @mercury-fw/cli-engine@0.59.0
  - @mercury-fw/utils@0.59.0

## 0.58.0

### Minor Changes

- e3eb49d: A turn its channel cancels isn't an answer anymore.

  - An aborted model call no longer leaves half an answer in the conversation history: the person's message stays, followed by a note that the answer was stopped, so the next message keeps its context. The same goes for a turn the stall watchdog stops.
  - A cancelled turn (its `abortSignal` aborted) is never finalized, run through the post-turn guards or archived, and it resolves instead of throwing; the sink is still released with `dispose`. Before, the AI SDK returned what it had and the turn delivered it as the answer.
  - Channel contract: the `abortSignal` doc says what a cancelled turn does. No change in shape, the contract version stays 6.

### Patch Changes

- Updated dependencies [e3eb49d]
  - @mercury-fw/channel-types@0.58.0
  - @mercury-fw/confirm-engine@0.58.0
  - @mercury-fw/plugin-types@0.58.0
  - @mercury-fw/cli-engine@0.58.0
  - @mercury-fw/utils@0.58.0

## 0.57.0

### Patch Changes

- @mercury-fw/plugin-types@0.57.0
- @mercury-fw/channel-types@0.57.0
- @mercury-fw/cli-engine@0.57.0
- @mercury-fw/confirm-engine@0.57.0
- @mercury-fw/utils@0.57.0

## 0.56.0

### Minor Changes

- 1126106: Every turn tells the model when and where the person wrote it.

  - Each message reaches the model after a line with the weekday, date, time and time zone it was written in (`[Wednesday 2026-10-21 14:32 Europe/Rome]`), and the system prompt says what that line is. The conversation's archive and what a UI shows of it keep the message as written.
  - A resumed conversation's messages come back stamped from the archive's timestamps.
  - The Layer 1 summary keeps when things were said; the episodic summary quotes a date only from those lines, never guessing one. The semantic-fact extractor and the capture card's preview leave the line out.
  - The time zone, always an IANA name (`Europe/Rome`), is the one the person saved, else the one their client is in when the channel passes it on, else the new `i18n.timeZone` in `mercury.config.ts`, else the machine's. A `timeZone` that isn't a zone's name stops the start.
  - The person saves theirs by telling the assistant (the new `set_time_zone` tool), or from a channel's settings.
  - Channel contract: `InboundTurn.timeZoneHint`, and `ctx.settings.setTimeZone` for a channel with a settings area; `reads.me` also returns the saved `timeZone`. Both are optional additions: the contract version stays 6.
  - HTTP channel: the `X-Time-Zone` header on `POST /turn` (allowed by CORS), `timeZone` in `GET /me`, and `PATCH /me` with `{ timeZone }` to save it. Needs the framework at 0.56 or later; an older core ignores the header and offers no `PATCH /me`.
  - Google Chat channel: the client's time zone (`common.timeZone`), when the event carries it, on messages and on the turn a click resumes.

  To set a default for an app's people, add `timeZone: "Europe/Rome"` (their zone) to `i18n` in `mercury.config.ts`; without it the machine's zone is used, often UTC inside a container.

### Patch Changes

- Updated dependencies [1126106]
  - @mercury-fw/channel-types@0.56.0
  - @mercury-fw/confirm-engine@0.56.0
  - @mercury-fw/plugin-types@0.56.0
  - @mercury-fw/cli-engine@0.56.0
  - @mercury-fw/utils@0.56.0

## 0.55.0

### Minor Changes

- eac72fa: Every plugin says what it lets the agent do, and the agent can tell. Plugin contract version 6:

  - A plugin declares a `description`: one sentence, in English, for the model, on what it lets the assistant do (`{{assistant}}` stands for its name). How to use it stays in its fragment and skills.
  - The core doesn't load a plugin whose description is missing, blank or more than one line, and the log says why.
  - The system prompt lists the plugins offered to the person, each with its description, right after the persona's identity, and tells the model to answer "what can you do?" from that list. A plugin the person may not use isn't listed; with no plugin offered there's no list.
  - The first-party plugins released with this change carry a description each, are written for contract 6 and need the framework at 0.55.0 or later: the peer range on `@mercury-fw/plugin-types` starts there.

  A plugin written for contract 5 isn't loaded by this core, and the log says why: add a `description` and rebuild it against `PLUGIN_API_VERSION` 6.

### Patch Changes

- Updated dependencies [eac72fa]
  - @mercury-fw/plugin-types@0.55.0
  - @mercury-fw/cli-engine@0.55.0
  - @mercury-fw/confirm-engine@0.55.0
  - @mercury-fw/channel-types@0.55.0
  - @mercury-fw/utils@0.55.0

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

- ebde9e2: The texts a person sees can be in their language. The core's own fixed texts (the refusal of someone the agent doesn't know, the account-linking replies, the login errors, the tool status lines, the terminal's own lines) are English, each under a key (`core.access.unknown`, …), and an app adds a language with a file of its own: `i18n: { defaultLocale, locales: { it } }` in `mercury.config.ts`, each file mapping keys to texts. A person picks their language by asking the agent, which saves it with `set_preferred_language` (only the languages the app ships; not offered when it ships English alone) and answers in it from then on. Whoever hasn't picked one gets `defaultLocale`, then English. A key a language's file lacks shows as the key itself, and the log names the missing keys at startup. `GET /me` on the HTTP channel also says the caller's language.

  The texts that were in Italian (tool status lines, the terminal's lines) are now English by default, and the language is no longer one of the facts inferred from conversations.

  An existing app keeps working, with these changes:

  1. `access.unknownMessage` is gone. To keep a custom refusal, put it in `locales/en.json` as `{ "core.access.unknown": "…" }`, and in `mercury.config.ts` import it (`import en from "./locales/en.json";`) and set `i18n: { locales: { en } }`.
  2. To keep the status and terminal lines in Italian, add `locales/it.json` with the `core.` keys translated (start it as `{}`: the log lists the missing keys at startup), and in `mercury.config.ts` import it (`import it from "./locales/it.json";`) and set `i18n: { defaultLocale: "it", locales: { it } }` (`locales: { en, it }` when you did step 1 too).
  3. Whenever the config imports a file from `locales/` (steps 1 and 2), the image needs the folder: add `COPY --chown=mercury:mercury locales ./locales` after the `mercury.config.ts` line of the `Dockerfile`, or the app fails at startup.
  4. For the terminal (`mfw repl`) to follow the language too, add `texts: app.texts,` to `createTerminalProvider({ … })` in `src/repl.ts`; without it the terminal's own lines stay English.

- 5015642: The plugins' texts a person sees come out in their language, like the core's. Plugin contract version 5:

  - A plugin declares its texts in English in `messages`, every key under its own name (`web-search.choice.once`); the core refuses a plugin with a key outside it (and a plugin named `core` or `app`, whose keys are the core's and the app's), and the app's language files translate them. The startup log names the missing keys of the plugins too.
  - While a turn runs, a plugin gets the texts of its person as `t`: in `SessionToolContext.t`, as the second argument of a status describer (`toolStatusDescribers`, `StatusDescriber`), the third of a post-processor (`CliPostProcessor`), and in a post-turn guard, whose `statusLabel` is now `(t) => string` and whose `run` gets `t` as its third argument. `Messages`, `Params` and `Translate` are part of the contract.
  - The default status line of a CLI command is the core's `core.status.command` ("Running jira issue search"), `core.status.command-bare` without a subcommand ("Running jira"), and an unreadable command's is `core.status.command-unknown`. `createCliTool` (`@mercury-fw/cli-engine`) takes the turn's `t` among its options, handed to the post-processor: a CLI plugin passes `sctx.t`; `createCliStatusDescriber`'s describer takes it as its second argument.
  - The formatter hands a rule `t` as its second argument, and an `empty` text can be `(t) => string`; existing rules keep working as they are. An app's own texts go under `app.`, in its `locales/en.json`, which declares them (the startup log no longer lists them as unknown); `mfw create` writes the Jira rule's empty text as `app.jira.no-issues`.
  - Web search: the two choices ("Only this time", "Always for \<host\>"), the status lines and the sources heading ("Sources") are `web-search.*` texts, English by default; a list of sources the model writes under the heading in the person's language, or the English one, is still replaced by the plugin's.

  The first-party plugins released with this change are written for contract 5 and need the core released with it: an older core skips them and says why in the log. A plugin written for contract 4 isn't loaded by this core either, and the log says why: rebuild it against `PLUGIN_API_VERSION` 5 (a status describer, a guard's `statusLabel` and `run`, a post-processor take the new `t`). An app that wants the web search and status lines back in Italian adds their keys to `locales/it.json` (the log lists the missing ones at startup).

### Patch Changes

- Updated dependencies [e00ff73]
- Updated dependencies [5015642]
  - @mercury-fw/channel-types@0.54.0
  - @mercury-fw/confirm-engine@0.54.0
  - @mercury-fw/plugin-types@0.54.0
  - @mercury-fw/cli-engine@0.54.0
  - @mercury-fw/utils@0.54.0

## 0.53.2

### Patch Changes

- @mercury-fw/plugin-types@0.53.2
- @mercury-fw/channel-types@0.53.2
- @mercury-fw/cli-engine@0.53.2
- @mercury-fw/confirm-engine@0.53.2
- @mercury-fw/utils@0.53.2

## 0.53.1

### Patch Changes

- Updated dependencies [edfebb5]
  - @mercury-fw/channel-types@0.53.1
  - @mercury-fw/confirm-engine@0.53.1
  - @mercury-fw/plugin-types@0.53.1
  - @mercury-fw/cli-engine@0.53.1
  - @mercury-fw/utils@0.53.1

## 0.53.0

### Minor Changes

- 56e4ed5: - A plugin can act as no one (`actsAs: "anyone"`): for a public service with no login, such as web search. It is offered to everyone (still within `access.plugins`), never with a variant acting as Mercury, and the operator gets it under its own names.
  - The tools of such a plugin get the turn's `person` all the same (the operator's key on the terminal), to keep what belongs to each person; they can't start a login.
  - An older core reads `"anyone"` as `"mercury"`: the plugin is offered only to whoever may make Mercury act as itself.
- c83b129: - New plugin `@mercury-fw/plugin-web-search`: `web_search` through a backend package of the app's choice, and `web_fetch` to read a page and hand the model its title and text.
  - A page is read right away only on a host the instance allows (`allowedHosts`) or the person allowed; for any other host the person chooses between reading that page only and allowing the host for good (their own list, kept in the plugin's folder), and the page goes back to the model either way.
  - Internal addresses are never read, redirects included, and only HTML and plain text are, up to 2 MB and 20,000 characters.
  - An answer built on pages ends with the list of the pages read (`Fonti:`).
  - A post-turn guard's `shouldRun` gets the turn's steps as a second argument.

### Patch Changes

- Updated dependencies [56e4ed5]
- Updated dependencies [c83b129]
  - @mercury-fw/plugin-types@0.53.0
  - @mercury-fw/cli-engine@0.53.0
  - @mercury-fw/confirm-engine@0.53.0
  - @mercury-fw/channel-types@0.53.0
  - @mercury-fw/utils@0.53.0

## 0.52.0

### Minor Changes

- 678c1cc: - A plugin gets a folder of its own on the vault's volume, `PluginRuntimeContext.dataDir` (`<vault>/.mercury/plugins/<name>/`), created by the core before `build()`: data it keeps there survives a restart, and never reaches the model or the wiki.
  - A plugin whose name isn't a safe folder name, or whose folder can't be created, gets none (the core logs why) and loads anyway.
- 7939ff2: - `@mercury-fw/core` exports `OPERATOR_PRINCIPAL`, the terminal's principal, for a caller that drives `handleTurn` itself as the operator.
  - `@mercury-fw/cli/e2e` exports `turnFromDump` and `createExpect`, so a tool running Mercury turns of its own reads and checks them the way `mfw e2e` does.

### Patch Changes

- Updated dependencies [678c1cc]
  - @mercury-fw/plugin-types@0.52.0
  - @mercury-fw/cli-engine@0.52.0
  - @mercury-fw/confirm-engine@0.52.0
  - @mercury-fw/channel-types@0.52.0
  - @mercury-fw/utils@0.52.0

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
  - @mercury-fw/confirm-engine@0.51.0
  - @mercury-fw/cli-engine@0.51.0
  - @mercury-fw/utils@0.51.0

## 0.50.4

### Patch Changes

- ef59194: - The turn log says how the model's generation ended (`finish stop`, for instance).
  - A turn whose generation ended on an error or at a token limit fails with an error instead of passing a cut answer off as complete.
  - @mercury-fw/plugin-types@0.50.4
  - @mercury-fw/channel-types@0.50.4
  - @mercury-fw/cli-engine@0.50.4
  - @mercury-fw/confirm-engine@0.50.4
  - @mercury-fw/utils@0.50.4

## 0.50.3

### Patch Changes

- 1b786af: - A turn on a streaming channel (the HTTP surface) whose model sends nothing for `TURN_STALL_TIMEOUT_MS` (default two minutes, `0` turns it off) is stopped with the error "the model sent nothing for N seconds", logged as stalled. It used to hang, holding its conversation, until the service restarted. A tool that takes long doesn't count: the wait pauses while a tool runs.
  - `mfw create` lists `TURN_STALL_TIMEOUT_MS` in a new app's env example.
  - @mercury-fw/plugin-types@0.50.3
  - @mercury-fw/channel-types@0.50.3
  - @mercury-fw/cli-engine@0.50.3
  - @mercury-fw/confirm-engine@0.50.3
  - @mercury-fw/utils@0.50.3

## 0.50.2

### Patch Changes

- 4e44ff8: - Every turn is logged: when it starts, when it ends (time, steps, tool calls, how much reasoning and answer text), when it fails or is cancelled, and every minute while it is still running. A turn with no tool calls, or one stuck in its reasoning, used to leave no trace.
  - @mercury-fw/plugin-types@0.50.2
  - @mercury-fw/channel-types@0.50.2
  - @mercury-fw/cli-engine@0.50.2
  - @mercury-fw/confirm-engine@0.50.2
  - @mercury-fw/utils@0.50.2

## 0.50.1

### Patch Changes

- d93e06a: - A new conversation on a channel where the person opens and reopens conversations (the HTTP surface) no longer starts with a recap of their last one: nothing from another conversation comes in unless they ask.
  - On a channel with one running stream (Google Chat), the recap of the last conversation reaches the model as background in its prompt, framed as possibly out of date. It used to arrive as the model's own message, which made it pick that thread back up, and the next summary saved it again.
  - Episodic summaries keep what was asked and decided, not the data a tool returned.
  - @mercury-fw/plugin-types@0.50.1
  - @mercury-fw/channel-types@0.50.1
  - @mercury-fw/cli-engine@0.50.1
  - @mercury-fw/confirm-engine@0.50.1
  - @mercury-fw/utils@0.50.1

## 0.50.0

### Minor Changes

- ae495c7: - The model is told, at the end of every prompt, which lists it already showed in the conversation: each one's ref and the command that built it, never the list itself. It can show one again with `present`, or run the command again for fresh data, instead of retyping it from memory.
  - A list shown in a conversation stays available for `present` as long as the conversation, previously five minutes, at most the ten most recent per conversation.
  - `stashDisplay` takes an optional label, and the cli-engine passes the command that built the list with its number of items.
  - The jira skill points to the lists already shown, and keeps a new search for fresh data.

### Patch Changes

- Updated dependencies [ae495c7]
  - @mercury-fw/plugin-types@0.50.0
  - @mercury-fw/cli-engine@0.50.0
  - @mercury-fw/confirm-engine@0.50.0
  - @mercury-fw/channel-types@0.50.0
  - @mercury-fw/utils@0.50.0

## 0.49.1

### Patch Changes

- 5d3bfdf: - The opening greeting asks for the person's name in words a model can't turn around: a small model had asked "how would I like you to call me?".
  - @mercury-fw/plugin-types@0.49.1
  - @mercury-fw/channel-types@0.49.1
  - @mercury-fw/cli-engine@0.49.1
  - @mercury-fw/confirm-engine@0.49.1
  - @mercury-fw/utils@0.49.1

## 0.49.0

### Minor Changes

- b7438a6: - The assistant remembers how each person wants to be called: they say it in conversation and the model saves it with the new `set_preferred_name` tool. It's a setting kept in `.mercury/profiles.json` on the vault's volume, not a wiki note, and every one-to-one turn tells the model the name.
  - A turn can be an opening (`opening: true`, with no text): the assistant speaks first, but only to someone whose name it doesn't know, introducing itself and asking how to call them. For anyone else, and in a shared space, it says nothing and keeps nothing.
  - `ChannelHostReads.me` says how the caller asked to be called, or `null`.
  - HTTP: `POST /turn` takes `{ opening: true, conversationId }`, and `GET /me` answers `{ name }`. A UI asks for an opening right after a sign-in, when the name is `null`. The channel now needs channel-types 0.49.0 or later.

### Patch Changes

- Updated dependencies [b7438a6]
  - @mercury-fw/channel-types@0.49.0
  - @mercury-fw/confirm-engine@0.49.0
  - @mercury-fw/plugin-types@0.49.0
  - @mercury-fw/cli-engine@0.49.0
  - @mercury-fw/utils@0.49.0

## 0.48.0

### Minor Changes

- 62bb3a3: - `persona.name` is the assistant's name, Mercury when left out. A name that's blank, longer than 40 characters or on more than one line stops the app at startup.
  - Every text the model reads refers to the name as `{{assistant}}`, and the core puts the persona's name there: the persona's identity and tone, the system prompt, plugin fragments, skills and tool descriptions. The model no longer takes "Mercury" for its own name when the app calls its assistant something else.
  - Where the one acting is the system around the model, the texts say "the system" or "this instance" instead of Mercury: the wiki tools, the cli-engine's errors, the jira skill and its issue lists.
  - Plugins get `assistantName` in their `build()` context, and channels in their runtime context, for texts they build while running. The login messages, the linking reply and the HTTP login page name the assistant that way.
  - The tools a person runs as the assistant itself are `<tool>AsSelf`, previously `<tool>AsMercury`. The `mercury.act-as-self` roles are unchanged.
  - `mfw create` writes the assistant's name as `persona.name`, with `persona/identity.md` and `persona/tone.md` referring to it. An existing app keeps working as it is: to rename its assistant everywhere, add `name` to its persona and write `{{assistant}}` in its persona files.

### Patch Changes

- Updated dependencies [62bb3a3]
  - @mercury-fw/plugin-types@0.48.0
  - @mercury-fw/channel-types@0.48.0
  - @mercury-fw/cli-engine@0.48.0
  - @mercury-fw/confirm-engine@0.48.0
  - @mercury-fw/utils@0.48.0

## 0.47.1

### Patch Changes

- @mercury-fw/plugin-types@0.47.1
- @mercury-fw/channel-types@0.47.1
- @mercury-fw/cli-engine@0.47.1
- @mercury-fw/confirm-engine@0.47.1
- @mercury-fw/utils@0.47.1

## 0.47.0

### Minor Changes

- 3d73e59: - `auth` in `mercury.config.ts` takes a list of providers as well as one: they're tried in order and the first that recognizes the caller decides who they are. One that fails to load, or fails on a request, is logged and the others still serve; a name taken twice is refused.
  - `createOidcAuth({ name })` is an OIDC provider of its own (`oidc-<name>`), configured by `OIDC_<NAME>_ISSUER` and `OIDC_<NAME>_AUDIENCE`, so an instance can accept several issuers. `oidcAuth` is unchanged.
  - A principal's provider can be `oidc-<name>`; each provider's people keep their own keys.
  - `zitadelDirectory` takes `ZITADEL_AUTH_PROVIDER`, the auth provider whose subjects are its users (default `oidc`).

### Patch Changes

- Updated dependencies [3d73e59]
  - @mercury-fw/channel-types@0.47.0
  - @mercury-fw/confirm-engine@0.47.0
  - @mercury-fw/plugin-types@0.47.0
  - @mercury-fw/cli-engine@0.47.0
  - @mercury-fw/utils@0.47.0

## 0.46.1

### Patch Changes

- a0dc010: - A reopened conversation shows the lists a turn showed: the verbatim archive keeps them next to the model's answer, and `GET /conversation` and the conversation list serve each answer as the person saw it.
  - A turn whose answer is only a shown list is archived too.
  - What goes back to the model (resuming a conversation, `recall_verbatim`) is still the model's own answer only.
  - @mercury-fw/plugin-types@0.46.1
  - @mercury-fw/channel-types@0.46.1
  - @mercury-fw/cli-engine@0.46.1
  - @mercury-fw/confirm-engine@0.46.1
  - @mercury-fw/utils@0.46.1

## 0.46.0

### Patch Changes

- Updated dependencies [4184ea6]
  - @mercury-fw/channel-types@0.46.0
  - @mercury-fw/confirm-engine@0.46.0
  - @mercury-fw/plugin-types@0.46.0
  - @mercury-fw/cli-engine@0.46.0
  - @mercury-fw/utils@0.46.0

## 0.45.0

### Minor Changes

- 812c9c5: - A conversation reopened on the HTTP surface after Mercury freed its history comes back to the model: the summaries of its older part plus its newest messages from the archive, within a budget.
  - What a resumed conversation brings back isn't captured to long-term memory again, only the new messages are.
  - `SESSION_RESUME_MAX_CHARS` sets how much comes back (default 30000, `0` turns it off); `HTTP_SURFACE_RESUME_MAX_CHARS` sets it for the HTTP surface only.
  - `InboundTurn.resume` lets a channel mark a conversation its client reopens.
  - The episodic collection gets a `sessionKey` index.
  - `mfw create` lists `HTTP_SURFACE_RESUME_MAX_CHARS` for the HTTP channel.
  - Core's README explains how Mercury remembers a conversation.

### Patch Changes

- Updated dependencies [812c9c5]
  - @mercury-fw/channel-types@0.45.0
  - @mercury-fw/confirm-engine@0.45.0
  - @mercury-fw/plugin-types@0.45.0
  - @mercury-fw/cli-engine@0.45.0
  - @mercury-fw/utils@0.45.0

## 0.44.1

### Patch Changes

- @mercury-fw/plugin-types@0.44.1
- @mercury-fw/channel-types@0.44.1
- @mercury-fw/cli-engine@0.44.1
- @mercury-fw/confirm-engine@0.44.1
- @mercury-fw/utils@0.44.1

## 0.44.0

### Minor Changes

- 2c63bbf: One person across accounts: linking them by a code.

  - `POST /link` on the HTTP surface hands the caller a one-time code (`xxxx-xxxx-xxxx`, ten minutes, single use). They send it from the other account, on any channel, twice. The first time Mercury says whom the account would be linked to, the second time it links it.
  - From then on the account is the person it's linked to: one private area, one memory, the same roles. Its earlier area stays where it was, and undoing the link gives it back.
  - A link never touches the terminal, never chains, and is refused for an account the directory already knows as someone else.
  - The links live on the vault's volume, out of the vault's git and out of reach of the model and the HTTP reads.
  - `mfw identity links | link | unlink` lets the operator manage them, for instances where nobody can be shown a code.
  - Channels get the code through the confirmation hook they already call (`ctx.confirm`), and the HTTP surface gets `ctx.linking`.
  - Fixed: `ctx.confirm` refused someone the core doesn't admit before checking that their text was a token at all. On Google Chat, every message from an unknown sender came back as the refusal.

### Patch Changes

- Updated dependencies [2c63bbf]
  - @mercury-fw/channel-types@0.44.0
  - @mercury-fw/confirm-engine@0.44.0
  - @mercury-fw/plugin-types@0.44.0
  - @mercury-fw/cli-engine@0.44.0
  - @mercury-fw/utils@0.44.0

## 0.43.0

### Patch Changes

- @mercury-fw/plugin-types@0.43.0
- @mercury-fw/channel-types@0.43.0
- @mercury-fw/cli-engine@0.43.0
- @mercury-fw/confirm-engine@0.43.0
- @mercury-fw/utils@0.43.0

## 0.42.0

### Minor Changes

- a7f2f13: A user directory decides who people are and what they may make Mercury do.

  - An app can declare a `directory` in `mercury.config.ts`. Given whoever a channel says is talking, it returns the person with their roles. The person's key is `<directory name>:<id>`, so one person reached from several channels keeps one private area, one memory and one set of confirmations.
  - With a directory the instance is closed. Someone it doesn't know gets a refusal and nothing runs, unless `access.unknown` is `"allow"`; `access.unknownMessage` sets what they're told. A directory that can't be reached, or fails to load, refuses everyone but the terminal. Answers are cached for five minutes, so a revoked role stops counting within that time.
  - `mercury.act-as-self` (every plugin) or `mercury.act-as-self.<plugin>` (one) lets a person make Mercury act with its own identity.
    - A plugin acting as Mercury, such as atlassian-admin, is offered only to those people, and on the terminal.
    - A plugin acting as the person also gives them each tool a second time, as `<tool>AsMercury`.
    - Every call made as Mercury for someone is logged with who asked.
  - `access.plugins` restricts a plugin to some roles. Prompts, skills and the manifest follow what each person is offered.
  - New package `@mercury-fw/directory-static`: people, their identities on each channel and their roles, listed in `DIRECTORY_STATIC_PEOPLE`.
  - The channel contract is at version 5:
    - `ChannelRuntimeContext.admit` says whether the core talks to a caller;
    - the reads are per person and async, the manifest included;
    - `DirectoryPlugin` is the directory contract;
    - `Principal` no longer carries `roles`.
  - `channel-http` answers `403` to a caller the directory doesn't know and `503` when it can't be reached, on every route.
  - `auth-static` refuses `roles` in `AUTH_STATIC_TOKENS`: roles come from the directory.

### Patch Changes

- Updated dependencies [a7f2f13]
  - @mercury-fw/channel-types@0.42.0
  - @mercury-fw/confirm-engine@0.42.0
  - @mercury-fw/plugin-types@0.42.0
  - @mercury-fw/cli-engine@0.42.0
  - @mercury-fw/utils@0.42.0

## 0.41.0

### Patch Changes

- @mercury-fw/plugin-types@0.41.0
- @mercury-fw/channel-types@0.41.0
- @mercury-fw/cli-engine@0.41.0
- @mercury-fw/confirm-engine@0.41.0
- @mercury-fw/utils@0.41.0

## 0.40.0

### Minor Changes

- 0739f77: A plugin acts as the person Mercury is talking to, who logs in to the service through Mercury.

  - Plugin contract version 4: a plugin declares `actsAs: "person" | "mercury"`, and one acting as the person contributes a `login`; its tools get the turn's `person` and `requireLogin` in their context.
  - A person is offered only the plugins acting as the person: their prompt fragments, skills and tools. A plugin acting as Mercury, or declaring nothing, is offered on the terminal only until people can be allowed to make Mercury act as itself; the startup log names it.
  - `createCliTool` adds `--user` with the person's id to every command, staged confirmations included, and when the CLI exits with code 3 (not logged in) returns their login instead. `createCliPersonLogin` builds a plugin's `login` on a CLI's two-step remote login. A failed `runCli` carries `exitCode`.
  - Channel contract version 4: channels get `logins` (`accept` a callback URL, `complete` a login) and `detectLoginRequired`.
  - The HTTP channel, with `HTTP_SURFACE_PUBLIC_URL` set, streams a `login` event with the link to open and takes the person back at `GET /login/callback`, public and protected by the single-use state.
  - `mercury.cliCredentials` can declare `userSetup`, run by `mfw credentials setup <plugin> --user-app`: the app people log in through, set up without logging anyone in.
  - plugin-jira and plugin-bitbucket act as the person, on CLIs 2.3.0: set up their people's app with `--user-app` and register `<HTTP_SURFACE_PUBLIC_URL>/login/callback` on it. Jira's skill now says `currentUser()` is the person.
  - plugin-atlassian-admin acts as Mercury, on CLI 0.2.0, whose `init` asks for the key without echoing it: until permissions exist it's available on the terminal only.
  - A third-party plugin needs `apiVersion: 4` to load, and `actsAs: "person"` with a `login` to be offered to people.

### Patch Changes

- Updated dependencies [0739f77]
  - @mercury-fw/plugin-types@0.40.0
  - @mercury-fw/channel-types@0.40.0
  - @mercury-fw/cli-engine@0.40.0
  - @mercury-fw/utils@0.40.0
  - @mercury-fw/confirm-engine@0.40.0

## 0.39.0

### Minor Changes

- 881835c: A CLI's login is set up inside the app's container, no longer carried in the env file.

  - A plugin declares in `mercury.cliCredentials` the commands that set its CLI's login up (`setup`, required), check it (`check`) and log an identity out (`logout`), each a binary followed by its arguments.
  - `mfw credentials setup <plugin>` runs the declared setup in a one-off container on your terminal, so the CLI writes its login straight onto the credentials volume; `mfw credentials check <plugin>` runs the declared check.
  - `mfw credentials reset <plugin> [--user <key>]` runs the declared logout, of the identity Mercury runs as or of one person, instead of deleting the CLI's folder.
  - `mfw credentials set` is removed, and the core no longer unpacks `*_CONFIG_TAR_B64` variables at startup: it reports a declared login that isn't set up yet, and still links a login kept outside `~/.config` to the volume.
  - A command the model writes with `--user` is refused: which person a CLI acts as is never the model's to pick.
  - `cliUserId` (`@mercury-fw/utils`) maps a user key to the id a CLI knows a person by.
  - plugin-jira and plugin-bitbucket pin their CLIs at 2.1.0, which keep the service identity and each person apart and refuse the old login folder. After updating, remove the plugin's `*_CONFIG_TAR_B64` line from the env file and run `mfw credentials setup` once; on Jira, Mercury now runs as an Atlassian Service Account.
  - plugin-atlassian-admin keeps its CLI at 0.1.2, whose `init` doesn't prompt for the organization key: until it does, write the key from `mfw shell` with `atlassian-admin init --api-key <KEY> --org-id <ORG_ID>` (the plugin's README says so).

### Patch Changes

- Updated dependencies [881835c]
  - @mercury-fw/utils@0.39.0
  - @mercury-fw/cli-engine@0.39.0
  - @mercury-fw/plugin-types@0.39.0
  - @mercury-fw/channel-types@0.39.0
  - @mercury-fw/confirm-engine@0.39.0

## 0.38.1

### Patch Changes

- @mercury-fw/plugin-types@0.38.1
- @mercury-fw/channel-types@0.38.1
- @mercury-fw/cli-engine@0.38.1
- @mercury-fw/confirm-engine@0.38.1
- @mercury-fw/utils@0.38.1

## 0.38.0

### Minor Changes

- de1ee52: Several people talking at once.

  - `@mercury-fw/core`: turns of one conversation run one after the other, on every channel. Before, two HTTP `/turn` on the same conversation id ran together and mixed up its history.
  - `@mercury-fw/core`: a turn waiting behind another one on the same conversation is dropped as soon as its client goes away.
  - `@mercury-fw/core`: the idle capture waits for a running turn before it closes a conversation, and a sweep never starts while the previous one is still running.
  - `@mercury-fw/core`: the capture a history compression triggers no longer leaves the capture marker wrong, which could make a later capture take the same messages twice or skip new ones.
  - `@mercury-fw/core`: the tool log is kept per person, so a busy person no longer pushes everyone else's calls out of it.
  - `@mercury-fw/core`: consolidation, `index.md` updates and confirmed promotions compare against the current file in the same queue as the write, so a concurrent update is never lost.
  - `@mercury-fw/core`: vault files are written through a temporary file and a rename, so a reader never sees one half written.
  - `@mercury-fw/core`: a vault file that exists but can't be read fails a write that depends on it, instead of counting as missing.
  - `@mercury-fw/core`: the nightly review rewrites or deletes only the version of a document it read, and rereads it when it changed meanwhile.
  - `@mercury-fw/core`: each pass of the nightly review gets up to 100 steps, up from 15.
  - `@mercury-fw/cli`: an e2e case on HTTP can send its turns in `lanes` that run at the same time, each as its own user, on a conversation of its own or one they share.

### Patch Changes

- @mercury-fw/plugin-types@0.38.0
- @mercury-fw/channel-types@0.38.0
- @mercury-fw/cli-engine@0.38.0
- @mercury-fw/confirm-engine@0.38.0
- @mercury-fw/utils@0.38.0

## 0.37.0

### Minor Changes

- fbaa7aa: The admin panel is gone.

  - Breaking, `@mercury-fw/core`: `composeMercury` no longer returns `startAdmin`, and `ADMIN_PANEL_ENABLED`/`ADMIN_PANEL_PORT` do nothing. An existing app removes the two lines of its `src/index.ts` that start and stop it (`const adminServer = app.startAdmin();` and `adminServer?.stop();`).
  - New apps don't start it.
  - What it showed is in the HTTP surface's read routes, scoped to the caller, and in `mfw vault` / `mfw memory` for the operator.

### Patch Changes

- @mercury-fw/plugin-types@0.37.0
- @mercury-fw/channel-types@0.37.0
- @mercury-fw/cli-engine@0.37.0
- @mercury-fw/confirm-engine@0.37.0
- @mercury-fw/utils@0.37.0

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
  - @mercury-fw/confirm-engine@0.36.0
  - @mercury-fw/plugin-types@0.36.0
  - @mercury-fw/cli-engine@0.36.0
  - @mercury-fw/utils@0.36.0

## 0.35.0

### Minor Changes

- 8d3e5af: Authentication for the HTTP surface.

  - An app declares an auth provider as `auth` in `mercury.config.ts`. The core builds it and hands channels `ctx.authenticate`. A provider that fails to load leaves the channel without it, so the surface stays closed.
  - New contract in `@mercury-fw/channel-types`: `AuthPlugin`, `AUTH_API_VERSION` and `Authenticate`. `PrincipalProvider` gains `oidc` and `static`.
  - New package `@mercury-fw/auth-oidc` verifies an OpenID Connect bearer token against the issuer's keys and checks `iss`, `aud` and expiry. It reads `OIDC_ISSUER` and `OIDC_AUDIENCE`.
  - New package `@mercury-fw/auth-static` maps fixed test tokens from `AUTH_STATIC_TOKENS` to users, for test apps and e2e tests.
  - Breaking, `@mercury-fw/channel-http`: the channel doesn't start without an auth provider.
  - `@mercury-fw/channel-http`: every route except `GET /openapi.yaml` and the `OPTIONS` preflights needs `Authorization: Bearer <token>`, and a missing or refused token gets `401` before anything runs.
  - Breaking, `@mercury-fw/channel-http`: a conversation belongs to whoever opened it. The session key is `<caller id>:<conversationId>`, so the same id from someone else is a conversation of their own. Existing HTTP conversations stay readable but can't be continued.
  - `@mercury-fw/channel-http`: a confirmation token is checked against the caller's own session, so it can't be confirmed from someone else's.
  - `@mercury-fw/channel-http`: authenticated callers get their own episodic memory and wiki area.
  - `@mercury-fw/channel-http`: the read routes (`/conversations`, `/conversation`, `/wiki/*`, `/memory/scroll`, `/tool-log`, `/confirmations`) need an authenticated caller, but still show every person's data. Scoping them per person comes next, so don't give the surface to people who shouldn't see each other's conversations yet. Confirmation tokens are never listed.
  - The HTTP `tool` event carries the name of the tool the model called. `TurnSink.onToolStart` gets it as an optional fourth argument.
  - `mfw create` pairs the HTTP channel with an auth provider: `--auth oidc|static`, which the wizard asks for once HTTP is chosen.
  - `mfw e2e` runs cases on the HTTP surface (`channel: "http"`) as one of the test's `users`, each a token the app accepts. A turn can name its own user, and it reports the response's status.
  - `mfw create --local-packages <folder>` makes an app on packed tarballs, as `mfw local-packages` does on an existing one. Versions come from the tarballs, so a package that isn't published yet works too.

### Patch Changes

- Updated dependencies [8d3e5af]
  - @mercury-fw/channel-types@0.35.0
  - @mercury-fw/confirm-engine@0.35.0
  - @mercury-fw/plugin-types@0.35.0
  - @mercury-fw/cli-engine@0.35.0
  - @mercury-fw/utils@0.35.0

## 0.34.0

### Minor Changes

- 8bed46b: - A turn carries a `Principal` (the person behind it and the provider that vouched for them) instead of the opaque `userId` and `wikiUserId`; the core derives every per-person id from it.
  - Episodic memory follows the principal, not the channel: a session is captured whenever a provider vouched for the person. Google Chat keeps the ids it had; the terminal and the HTTP channel (until it authenticates its callers) send a principal nobody vouched for, so they stay out of episodic memory as before.
  - The HTTP channel accepts a `conversationId` on `/turn` and `/confirm` only made of letters, digits, `-` and `_`, up to 128 characters once trimmed, and answers `400` otherwise: a client-chosen id can no longer reach another user's wiki notes, forge log lines or break the turn. An existing HTTP conversation whose id has other characters can still be read with `/conversation`, but not continued. `/conversation` keeps opening any session key `/conversations` lists, whatever channel it came from.
  - The model's wiki read tools refuse a per-user id that isn't one path segment, as writes already did.
  - `CHANNEL_API_VERSION` is 2: a channel written for version 1 is refused at load.
  - The first-party channels declare their channel api version as a literal, so an older channel can't claim a newer contract it doesn't implement.

### Patch Changes

- Updated dependencies [8bed46b]
  - @mercury-fw/channel-types@0.34.0
  - @mercury-fw/confirm-engine@0.34.0
  - @mercury-fw/plugin-types@0.34.0
  - @mercury-fw/cli-engine@0.34.0
  - @mercury-fw/utils@0.34.0

## 0.33.0

### Minor Changes

- a493d9b: - A plugin whose CLI keeps its login in a folder declares it in its `package.json` (`mercury.cliCredentials`): `{ folder }` under `~/.config`, the default, or `{ path }` anywhere else under the home. Any plugin's CLI gets the login mechanism, not only the first-party ones.
  - The core unpacks each declared login from its env variable onto the credentials volume (`~/.config`) at startup, only when the folder isn't there yet, for the service and the REPL alike; a folder declared elsewhere in the home lives on the volume under `~/.config/mercury-home`, linked from its usual place. It warns about a declared folder with neither the folder nor the variable.
  - `mfw credentials set|reset <plugin>` names the plugin by its package or its CLI's folder (`@mercury-fw/plugin-jira` or `jira-cli`), read from the app's installed plugins; the short name (`jira`) is no longer accepted, and reset asks for the folder's name.
  - `mfw create` no longer writes `docker-entrypoint.sh` or the credentials variables in the env example, and always mounts the `cli-credentials` volume; an existing app's entrypoint keeps working alongside.
  - The generated README explains how a plugin's CLI gets its login without listing plugins.
  - jira, bitbucket and atlassian-admin declare their CLI's login folder; their READMEs point to `mfw credentials set`.

### Patch Changes

- Updated dependencies [a493d9b]
  - @mercury-fw/utils@0.33.0
  - @mercury-fw/plugin-types@0.33.0
  - @mercury-fw/channel-types@0.33.0
  - @mercury-fw/cli-engine@0.33.0
  - @mercury-fw/confirm-engine@0.33.0

## 0.32.0

### Minor Changes

- 1fa3a97: - Every tool plugin declared in `mercury.config.ts` loads: `MERCURY_CLIS` is no longer read. An app that used it to keep a declared plugin off now gets that plugin on; remove the plugin from the config instead.
  - A new app's env example has no `MERCURY_CLIS`, and its config's comment says every declared plugin and channel is active.
  - A plugin caught in a dependency cycle is always reported at startup.
  - The plugins' READMEs no longer ask to list them in `MERCURY_CLIS`.

### Patch Changes

- @mercury-fw/plugin-types@0.32.0
- @mercury-fw/channel-types@0.32.0
- @mercury-fw/cli-engine@0.32.0
- @mercury-fw/confirm-engine@0.32.0

## 0.31.1

### Patch Changes

- 7926aa2: - Wiki grep ignores case, for the agent, the nightly review, `mfw vault grep` and the HTTP `/wiki/grep` route.
  - The agent's `write_file` and the nightly review's `write_curated` take a path starting with `curated/`, as listing, reading and grepping give it, instead of writing under `curated/curated/`.
  - @mercury-fw/plugin-types@0.31.1
  - @mercury-fw/channel-types@0.31.1
  - @mercury-fw/cli-engine@0.31.1
  - @mercury-fw/confirm-engine@0.31.1

## 0.31.0

### Patch Changes

- 6ae8133: - `mfw local-packages <folder>` makes an app install `@mercury-fw/*` packages from local tarballs (`bun pm pack`) instead of the registry, transitive dependencies included; `--off` goes back to the registry.
  - `mfw e2e` runs end-to-end tests against an app's real model through its REPL: cases of turns with checks on the tool calls and the answer, repeated runs, results kept in `e2e/results/`.
  - Test files declare their cases with `e2e()` from `@mercury-fw/cli/e2e`.
  - A new app's Dockerfile copies `.packs/` when present, and its `.gitignore` leaves out `.packs/` and `e2e/results/`.
  - In the REPL, `/dump` after a confirmation no longer writes the turn before it.
  - @mercury-fw/plugin-types@0.31.0
  - @mercury-fw/channel-types@0.31.0
  - @mercury-fw/cli-engine@0.31.0
  - @mercury-fw/confirm-engine@0.31.0

## 0.30.0

### Patch Changes

- @mercury-fw/plugin-types@0.30.0
- @mercury-fw/channel-types@0.30.0
- @mercury-fw/cli-engine@0.30.0
- @mercury-fw/confirm-engine@0.30.0

## 0.29.4

### Patch Changes

- 63f3da2: - Before writing to the wiki, the agent looks for a document on the same topic and updates it, instead of adding a new one each time.
  - The agent no longer writes wiki notes restating a CLI's syntax or flags, which the plugin's skill and `--help` already cover.
  - A learned command correction is keyed by the flag or subcommand it is about, without the tool's name, so corrections on the same flag land in the same note.
  - The prompts that extract command corrections and facts about the user are in English.
  - @mercury-fw/plugin-types@0.29.4
  - @mercury-fw/channel-types@0.29.4
  - @mercury-fw/cli-engine@0.29.4
  - @mercury-fw/confirm-engine@0.29.4

## 0.29.3

### Patch Changes

- @mercury-fw/plugin-types@0.29.3
- @mercury-fw/channel-types@0.29.3
- @mercury-fw/cli-engine@0.29.3
- @mercury-fw/confirm-engine@0.29.3

## 0.29.2

### Patch Changes

- @mercury-fw/plugin-types@0.29.2
- @mercury-fw/channel-types@0.29.2
- @mercury-fw/cli-engine@0.29.2
- @mercury-fw/confirm-engine@0.29.2

## 0.29.1

### Patch Changes

- 60916cb: - The wiki vault's automated commits are authored as `Mercury <mercury@mercury.local>`. Commits written before keep their old address; `git log --author=Mercury` matches both.
  - The Jira issue-list extractor's docs use a generic example site.
  - @mercury-fw/plugin-types@0.29.1
  - @mercury-fw/channel-types@0.29.1
  - @mercury-fw/cli-engine@0.29.1
  - @mercury-fw/confirm-engine@0.29.1

## 0.29.0

### Patch Changes

- @mercury-fw/plugin-types@0.29.0
- @mercury-fw/channel-types@0.29.0
- @mercury-fw/cli-engine@0.29.0
- @mercury-fw/confirm-engine@0.29.0

## 0.28.4

### Patch Changes

- @mercury-fw/plugin-types@0.28.4
- @mercury-fw/channel-types@0.28.4
- @mercury-fw/cli-engine@0.28.4
- @mercury-fw/confirm-engine@0.28.4

## 0.28.3

### Patch Changes

- @mercury-fw/plugin-types@0.28.3
- @mercury-fw/channel-types@0.28.3
- @mercury-fw/cli-engine@0.28.3
- @mercury-fw/confirm-engine@0.28.3

## 0.28.2

### Patch Changes

- 0c5bb5b: Dependencies at their latest minor: `ai` 7.0.126, `ai-sdk-ollama` 4.4.0, `zod` 4.6.5, `yaml` 2.9.1, `shell-quote` 1.11.0. A new app from `mfw create` runs Qdrant on its `v1` tag, which follows every 1.x release, instead of a fixed 1.19.0, and gets `@types/bun` `^1.4.2`.
  - @mercury-fw/plugin-types@0.28.2
  - @mercury-fw/channel-types@0.28.2
  - @mercury-fw/cli-engine@0.28.2
  - @mercury-fw/confirm-engine@0.28.2

## 0.28.1

### Patch Changes

- @mercury-fw/plugin-types@0.28.1
- @mercury-fw/channel-types@0.28.1
- @mercury-fw/cli-engine@0.28.1
- @mercury-fw/confirm-engine@0.28.1

## 0.28.0

### Patch Changes

- @mercury-fw/plugin-types@0.28.0
- @mercury-fw/channel-types@0.28.0
- @mercury-fw/cli-engine@0.28.0
- @mercury-fw/confirm-engine@0.28.0

## 0.27.1

### Patch Changes

- 2c0e020: The REPL no longer prints the answer a second time, under "risposta corretta rispetto a quanto già mostrato sopra", after a turn that reasoned or called a tool.
  - @mercury-fw/plugin-types@0.27.1
  - @mercury-fw/channel-types@0.27.1
  - @mercury-fw/cli-engine@0.27.1
  - @mercury-fw/confirm-engine@0.27.1

## 0.27.0

### Patch Changes

- @mercury-fw/plugin-types@0.27.0
- @mercury-fw/channel-types@0.27.0
- @mercury-fw/cli-engine@0.27.0
- @mercury-fw/confirm-engine@0.27.0

## 0.26.0

### Minor Changes

- 8b92abb: - `mfw` operates an app from inside its folder: `start`, `stop` and `restart` (with `--no-cache`), `logs`, `repl`, `shell`, all as `docker compose` calls.
  - `mfw vault` maintains the wiki vault (`list`, `read`, `grep`, `write-curated`, `write-raw`) in a one-off container.
  - `mfw memory list` and `mfw memory read <collection>` read the memory on Qdrant, newest first where the collection has a timestamp index.
  - `mfw reset memory` and `mfw reset wiki` delete a memory volume after you type the app's name, then bring the service back up empty; after a memory reset a running app is restarted, so it sets up its collections again.
  - The command line is declared with commander: `--help` at every level, a suggestion for a mistyped command, and every argument checked before anything runs.
  - A scaffolded app lists `@mercury-fw/cli` among its devDependencies, at the framework's version, and its README runs it through `bunx mfw`.
  - A scaffolded app's `@types/bun` and `typescript` use caret ranges instead of exact versions.
  - The core ships a read-only memory CLI (`src/memory/memory-cli.ts`) next to the vault one, which is what `mfw memory` runs.
  - The vault CLI says so when asked to read a note that doesn't exist, instead of printing a stack trace.

### Patch Changes

- @mercury-fw/plugin-types@0.26.0
- @mercury-fw/channel-types@0.26.0
- @mercury-fw/cli-engine@0.26.0
- @mercury-fw/confirm-engine@0.26.0

## 0.25.1

### Patch Changes

- 5613e5e: - Mercury starts even when Qdrant isn't answering yet: the memory collections are set up in the background and retried until Qdrant is reachable, instead of crashing the process at startup.
  - A new session's context primer goes on without the last-session recap when Qdrant doesn't answer, instead of failing the turn.
  - The scaffolded app's `docker-compose.yml` restarts the app service unless it was stopped.
  - @mercury-fw/plugin-types@0.25.1
  - @mercury-fw/channel-types@0.25.1
  - @mercury-fw/cli-engine@0.25.1
  - @mercury-fw/confirm-engine@0.25.1

## 0.25.0

### Minor Changes

- c114e34: - Mercury is published on npm as `@mercury-fw/*`: the framework packages move together under one version, plugins and channels have versions of their own.
  - `bun create mercury-agent my-agent` scaffolds an app, and the CLI command is now `mfw` (`@mercury-fw/cli`).
  - Packages ship type declarations, so a new app type-checks against the framework without re-checking its source.
  - External dependencies use version ranges instead of exact pins, so an app shares them with the framework.
  - Every package has its own README, and the repo README describes the framework.
  - MIT license.

### Patch Changes

- @mercury-fw/plugin-types@0.25.0
- @mercury-fw/channel-types@0.25.0
- @mercury-fw/cli-engine@0.25.0
- @mercury-fw/confirm-engine@0.25.0
