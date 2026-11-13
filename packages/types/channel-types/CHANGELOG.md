# @mercury-fw/channel-types

## 0.75.0

### Minor Changes

- bf7b7f3: - **Breaking:** plugin contract 7 (`PLUGIN_API_VERSION`): a plugin written for contract 6 isn't loaded, and the log says why: rebuild it against 7
  - `Plugin.needs` (`PluginNeed`: `"vectorIndex"`, `"conversationStore"`, `"embedding"`): the plugin's `build()` context gets `vectorIndex`, `conversations`, `embed`; a need the config doesn't declare stops the start, one declared that didn't start leaves the plugin out
  - `build()` may return a promise, awaited at startup; one that rejects leaves the plugin out
  - every plugin's `build()` context gets `backgroundModel`, `daily(name, { at, timeZone? }, fn)`, `profiles` and `toolLog`
  - `daily`: work every day at `"HH:MM"` in `timeZone` or `i18n.timeZone`, run by the service only, a missed day never made up; an `at` or a time zone that can't be stops the start
  - `PluginRuntimeContributions.conversation` (`ConversationOwner`, `Conversation`, `ConversationOpen`, `ConversationMessage`): a plugin keeping a session's conversation
  - `context.profiles.<p>.conversation`: the plugin keeping that profile's conversations. One not in `plugins` or keeping none, and a plugin keeping conversations that no profile names, stop the start
  - `ContextRequest.reopened`: whether the conversation is one its client reopened
  - `VectorIndex`, `ConversationStore`, `StoredMessage`, `StoredTitle`, `CallRecord`, `CallResult`, `TraceEntry`, `ArchivedConfirmation`, `ToolOutcome` are in the plugin contract; `@mercury-fw/channel-types` re-exports them
  - **Breaking:** `StoredMessage` lists its fields (`role`, `content`, `displays`, `calls`, `interrupted`, `trace`, `pendingNote`, `confirmation`, `turnId`): a store or a writer adding other fields no longer typechecks
  - `formatterPlugin` awaits the plugin's `build()`: its own `build()` returns a promise
  - **Migration:** a test calling a plugin's `build()` awaits it: `await plugin.build!(ctx)`
- 2df58af: - new `@mercury-fw/wiki`: `wiki({ vaultPath?, review? })`, the vault (`WIKI_VAULT_PATH` by default), the tools `list_files`, `read_file`, `grep`, `write_file`, `promote_note`, a `session` layer with `index.md`, the nightly review at `review.at` (`"03:00"` by default, `false` for none); in the framework's fixed group
  - the nightly review's passes are `background.job` events `wiki:review-raw`, `wiki:review-index`, `wiki:review-contradictions`; no `review.pass` event
  - the wiki tools' status lines are `wiki.status.read`, `wiki.status.write`, `wiki.status.search`; `core.status.wiki-read`, `core.status.wiki-write`, `core.status.searching` are gone
  - **Breaking:** the core keeps no wiki: no wiki tools, no wiki text in the system prompt, no wiki index in the primer, no nightly review, `WIKI_VAULT_PATH` no longer required: declare `wiki()`
  - the confirmation notes are kept in the data folder, `confirmations/<key>/<token>.md`; the ones in the vault (`users/<key>/confirmations/`) are copied there at the first start, from `WIKI_VAULT_PATH`
  - an old vault layout's `inferred/confirmations/` stays where it is
  - `resolve_reference` is the core's, offered on every turn
  - **Breaking:** `ChannelHostReads` has no `wikiList`, `wikiRead`, `wikiGrep`
  - **Breaking:** `channel-http` has no `GET /wiki/list`, `/wiki/read`, `/wiki/grep`
  - **Breaking:** confirm-engine's `WriteConfirmationNote` takes no path, and `ConfirmDeps` and the staging deps have no `vaultPath`
  - `mfw create` declares `const teamWiki = wiki()`, in `plugins` and in the `default` profile's `layers`
  - `mfw vault` runs `@mercury-fw/wiki`'s CLI
  - **Migration:** keep `WIKI_VAULT_PATH` set on the first start, so the confirmation notes are copied from the vault
  - **Migration:** an app's language files translating `core.status.wiki-read`, `core.status.wiki-write`, `core.status.searching` translate `wiki.status.read`, `wiki.status.write`, `wiki.status.search` instead
  - **Migration:** `bun add @mercury-fw/wiki`, then in `mercury.config.ts` add `import { wiki } from "@mercury-fw/wiki";`, `const teamWiki = wiki();`, `teamWiki` in `plugins`, and `teamWiki` in the `layers` of each context profile that should read the wiki's index

### Patch Changes

- Updated dependencies [21716af]
- Updated dependencies [4d0c1ed]
- Updated dependencies [bf7b7f3]
  - @mercury-fw/plugin-types@0.75.0

## 0.74.0

### Minor Changes

- 9c78729: - context layers declare knobs (`context.knobs`, `KnobSpec`: `boolean`, `integer`, `number`, `string`, `enum`); `req.knobs` holds each one's value in the person's profile, or its default
  - a plugin whose knob spec contradicts itself isn't loaded
  - a profile's `maxChars`, layer order and knobs can change while the instance runs, for people holding `mercury.context-admin`; kept in `context-settings.json` in the data folder, each change recorded in `context-changes.jsonl` and as a `context.changed` event
  - channel contract: `ctx.contextAdmin` (`read`, `update`, `changes`), on an instance with a `context`
  - channel-http: `GET /context`, `PATCH /context/profiles/{name}`, `GET /context/changes`
  - directory-static: README names the `mercury.context-admin` role

### Patch Changes

- Updated dependencies [9c78729]
- Updated dependencies [52c8130]
- Updated dependencies [c7a0a56]
  - @mercury-fw/plugin-types@0.74.0

## 0.73.0

### Minor Changes

- fb1f30a: - conversation-store contract: `ConversationStorePlugin`, `ConversationStore`, `StoredMessage`, `StoredTitle`, `CONVERSATION_STORE_API_VERSION`
  - `conversationStore` in `mercury.config.ts`: where every conversation's messages and title are kept
  - **Breaking:** without `conversationStore` nothing is archived: no reopened or listed conversations, no titles, no `recall_verbatim`
  - `qdrantConversations()` in `@mercury-fw/store-qdrant`: messages in `conversation_messages` (`QDRANT_MESSAGES_COLLECTION`), titles in `conversation_titles` (`QDRANT_TITLES_COLLECTION`); on start, copies the messages of `verbatim_archive` into `conversation_messages` once, marking the copy done only when all are in
  - `@mercury-fw/core` no longer depends on `@qdrant/js-client-rest` and no longer reads `QDRANT_URL`
  - **Breaking:** `GET /health` (HTTP): `conversationStoreReachable` and `vectorIndexReachable` (`null` when not declared) instead of `qdrantReachable`
  - **Breaking:** channel contract 7: `ChannelHostReads.conversation`, `conversations` and `memoryScroll` optional, given only with a conversation store / a vector index; channels written for contract 6 are refused
  - `channel-http`, `channel-google-chat`: channel contract 7, framework 0.73 or later
  - `channel-http`: `/conversation`, `/conversations` (`GET`, `PATCH`) only with a conversation store, `/memory/scroll` only with a vector index; `404` otherwise
  - `system.start` trace event: `conversationStore` (`declared`, `active`)
  - `mfw create`: new apps declare `conversationStore: qdrantConversations()`
  - **Migration:** in `mercury.config.ts`, import `qdrantConversations` from `@mercury-fw/store-qdrant` and add `conversationStore: qdrantConversations(),`; upgrade `@mercury-fw/channel-http` and `@mercury-fw/channel-google-chat` with the framework; a UI reading `qdrantReachable` from `/health` reads the two new fields
- b634bd1: - vector-index contract: `VectorIndexPlugin`, `VectorIndex`, `VectorPoint`, `VectorSpaceSpec`, `VectorWhere`, `VECTOR_INDEX_API_VERSION`
  - `vectorIndex` in `mercury.config.ts`: where episodes, semantic facts, procedural corrections and `recall_verbatim`'s search are kept
  - **Breaking:** without `vectorIndex` there is no long-term memory: no conversation summaries, no corrections, no `recall_verbatim` (tool and prompt), idle conversations closed without a summary
  - new package `@mercury-fw/store-qdrant`: `qdrantIndex()`, Qdrant at `QDRANT_URL`, each space the collection of the same name or the one its `QDRANT_*_COLLECTION` names
  - the memory's vector length comes from the embedding model at startup; `QDRANT_*_VECTOR_SIZE` no longer read
  - `GET /memory/scroll` (HTTP) takes the index's space name (`episodic_memory`, `semantic_facts`, `verbatim_archive`), not the `QDRANT_*_COLLECTION` name
  - `system.start` trace event: `vectorIndex` (`declared`, `active`)
  - `mfw memory` runs the memory CLI of `@mercury-fw/store-qdrant`
  - `mfw create`: new apps declare `vectorIndex: qdrantIndex()` and depend on `@mercury-fw/store-qdrant`
  - **Migration:** add `@mercury-fw/store-qdrant` to the app's dependencies, at the framework's version; in `mercury.config.ts`, `import { qdrantIndex } from "@mercury-fw/store-qdrant";` and `vectorIndex: qdrantIndex(),`; `QDRANT_*_VECTOR_SIZE` can go from `.env`

### Patch Changes

- Updated dependencies [a8e2fe9]
- Updated dependencies [4a00b0c]
- Updated dependencies [40fde6b]
  - @mercury-fw/plugin-types@0.73.0

## 0.72.0

### Minor Changes

- 468cb12: - add the trace sink contract: `TraceSinkPlugin`, `TraceSink`, `TraceEvent`, `TRACE_SINK_API_VERSION`

### Patch Changes

- @mercury-fw/plugin-types@0.72.0

## 0.71.0

### Patch Changes

- Updated dependencies [2b08f7e]
  - @mercury-fw/plugin-types@0.71.0

## 0.70.0

### Minor Changes

- 07d1ef6: - conversations get a title, generated from the first question and its answer after the first turn the person wrote
  - channel contract: optional `ctx.conversations` with `rename`, the title the person chose, never replaced by a generated one
  - `GET /conversations` and `GET /conversation` carry `title` once a conversation has one
  - `PATCH /conversation?id=<conversationId>` with `{ title }` renames one of the caller's conversations

### Patch Changes

- @mercury-fw/plugin-types@0.70.0

## 0.69.0

### Patch Changes

- @mercury-fw/plugin-types@0.69.0

## 0.68.0

### Minor Changes

- 148417b: - a step whose tool asks the person to log in ends the turn: no further tool calls
  - the turn's text closes with `core.login.note`, naming the services to log in to (`core.login.note-any` when none has a name)
  - `detectLoginRequests(step)` in `@mercury-fw/channel-types`: every login a step asks for, one per link
  - HTTP channel: one `login` event per service the step asks for
  - Google Chat: one login card per service the step asks for
  - **Migration:** apps with their own locale files add `core.login.note` (`{services}`) and `core.login.note-any` to each non-English one

### Patch Changes

- @mercury-fw/plugin-types@0.68.0

## 0.67.0

### Patch Changes

- @mercury-fw/plugin-types@0.67.0

## 0.66.0

### Patch Changes

- @mercury-fw/plugin-types@0.66.0

## 0.65.1

### Patch Changes

- @mercury-fw/plugin-types@0.65.1

## 0.65.0

### Minor Changes

- 7a76257: An app can show its own version next to the framework's.

  - `version` in `mercury.config.ts`: the app's version, as its `package.json` has it. The core hands it to the channels as `ctx.appVersion`, trimmed and otherwise as written; left out or empty, channels get none.
  - Mercury only shows that number: moving it is up to the app (by hand, with Changesets, or with a script before pushing), and a new one shows once the app is rebuilt.

  An existing app that wants it adds two lines to `mercury.config.ts`: `import pkg from "./package.json";` at the top, and `version: pkg.version,` in `defineMercuryConfig`. The HTTP channel's `GET /version` shows it to anyone, with no token: leave it out to show none.

### Patch Changes

- @mercury-fw/plugin-types@0.65.0

## 0.64.0

### Patch Changes

- @mercury-fw/plugin-types@0.64.0

## 0.63.0

### Patch Changes

- @mercury-fw/plugin-types@0.63.0

## 0.62.0

### Patch Changes

- @mercury-fw/plugin-types@0.62.0

## 0.61.0

### Minor Changes

- 1e7fdeb: A turn resumed after a confirmation with nothing left to resume says so instead of ending with an empty answer.

  - The core keeps a confirmed action's result for its resumed turn five minutes, and once: later, after a restart, or a second time, the turn now answers "The action was confirmed, but its answer is no longer available: ask me about it again." (`core.resume.gone`), in the person's language, on every channel. The model isn't called and nothing goes into the history.
  - An empty answer to a resumed turn now always comes from the model.

  An app with language files other than English adds `core.resume.gone` to them (the log lists it as missing at startup).

### Patch Changes

- @mercury-fw/plugin-types@0.61.0

## 0.60.0

### Patch Changes

- @mercury-fw/plugin-types@0.60.0

## 0.59.2

### Patch Changes

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.
- Updated dependencies [f631dd5]
  - @mercury-fw/plugin-types@0.59.2

## 0.59.1

### Patch Changes

- @mercury-fw/plugin-types@0.59.1

## 0.59.0

### Minor Changes

- 7c9a038: - Channels get the framework's version on their runtime context (`ctx.frameworkVersion`, `major.minor.patch`), for a channel that tells people which Mercury they're talking to.

### Patch Changes

- @mercury-fw/plugin-types@0.59.0

## 0.58.0

### Minor Changes

- e3eb49d: A turn its channel cancels isn't an answer anymore.

  - An aborted model call no longer leaves half an answer in the conversation history: the person's message stays, followed by a note that the answer was stopped, so the next message keeps its context. The same goes for a turn the stall watchdog stops.
  - A cancelled turn (its `abortSignal` aborted) is never finalized, run through the post-turn guards or archived, and it resolves instead of throwing; the sink is still released with `dispose`. Before, the AI SDK returned what it had and the turn delivered it as the answer.
  - Channel contract: the `abortSignal` doc says what a cancelled turn does. No change in shape, the contract version stays 6.

### Patch Changes

- @mercury-fw/plugin-types@0.58.0

## 0.57.0

### Patch Changes

- @mercury-fw/plugin-types@0.57.0

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

- @mercury-fw/plugin-types@0.56.0

## 0.55.0

### Patch Changes

- Updated dependencies [eac72fa]
  - @mercury-fw/plugin-types@0.55.0

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

- Updated dependencies [5015642]
  - @mercury-fw/plugin-types@0.54.0

## 0.53.2

### Patch Changes

- @mercury-fw/plugin-types@0.53.2

## 0.53.1

### Patch Changes

- edfebb5: - `@mercury-fw/plugin-web-search`: an answer no longer lists its sources twice. When the model writes its own list of sources at the end of the answer, the plugin's `Fonti:` list replaces it, and `web_fetch`'s description tells the model the pages it reads are listed for it.
  - `@mercury-fw/channel-google-chat`: once a choice on a confirmation card is taken, the card shows it ("Scelto: …") instead of the buttons. A click that confirms nothing (expired, or someone else's in a shared space) leaves the card as it is.
  - `@mercury-fw/channel-types`: `confirmReply(outcome)`, the reply to each confirmation outcome, for a channel that resolves a token through `resolveConfirmation`.
  - `@mercury-fw/confirm-engine`: `tryConfirm` answers with `confirmReply`, same texts as before.
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

### Minor Changes

- b7438a6: - The assistant remembers how each person wants to be called: they say it in conversation and the model saves it with the new `set_preferred_name` tool. It's a setting kept in `.mercury/profiles.json` on the vault's volume, not a wiki note, and every one-to-one turn tells the model the name.
  - A turn can be an opening (`opening: true`, with no text): the assistant speaks first, but only to someone whose name it doesn't know, introducing itself and asking how to call them. For anyone else, and in a shared space, it says nothing and keeps nothing.
  - `ChannelHostReads.me` says how the caller asked to be called, or `null`.
  - HTTP: `POST /turn` takes `{ opening: true, conversationId }`, and `GET /me` answers `{ name }`. A UI asks for an opening right after a sign-in, when the name is `null`. The channel now needs channel-types 0.49.0 or later.

### Patch Changes

- @mercury-fw/plugin-types@0.49.0

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

## 0.47.1

### Patch Changes

- @mercury-fw/plugin-types@0.47.1

## 0.47.0

### Minor Changes

- 3d73e59: - `auth` in `mercury.config.ts` takes a list of providers as well as one: they're tried in order and the first that recognizes the caller decides who they are. One that fails to load, or fails on a request, is logged and the others still serve; a name taken twice is refused.
  - `createOidcAuth({ name })` is an OIDC provider of its own (`oidc-<name>`), configured by `OIDC_<NAME>_ISSUER` and `OIDC_<NAME>_AUDIENCE`, so an instance can accept several issuers. `oidcAuth` is unchanged.
  - A principal's provider can be `oidc-<name>`; each provider's people keep their own keys.
  - `zitadelDirectory` takes `ZITADEL_AUTH_PROVIDER`, the auth provider whose subjects are its users (default `oidc`).

### Patch Changes

- @mercury-fw/plugin-types@0.47.0

## 0.46.1

### Patch Changes

- @mercury-fw/plugin-types@0.46.1

## 0.46.0

### Minor Changes

- 4184ea6: - `loginLinkText` words a login link the same way on every channel, and the contract states that a login link is shown only to the person it's for.
  - Google Chat shows the login to a service a plugin acts on as the person (Jira, Bitbucket) as a button that opens it, visible only to them: in a shared space it's a private message to whoever asked.
  - `@mercury-fw/channel-google-chat` needs `@mercury-fw/channel-types` 0.46.0 or later.

### Patch Changes

- @mercury-fw/plugin-types@0.46.0

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

- @mercury-fw/plugin-types@0.45.0

## 0.44.1

### Patch Changes

- @mercury-fw/plugin-types@0.44.1

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

- @mercury-fw/plugin-types@0.44.0

## 0.43.0

### Patch Changes

- @mercury-fw/plugin-types@0.43.0

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

- @mercury-fw/plugin-types@0.42.0

## 0.41.0

### Patch Changes

- @mercury-fw/plugin-types@0.41.0

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

- @mercury-fw/plugin-types@0.36.0

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

- @mercury-fw/plugin-types@0.35.0

## 0.34.0

### Minor Changes

- 8bed46b: - A turn carries a `Principal` (the person behind it and the provider that vouched for them) instead of the opaque `userId` and `wikiUserId`; the core derives every per-person id from it.
  - Episodic memory follows the principal, not the channel: a session is captured whenever a provider vouched for the person. Google Chat keeps the ids it had; the terminal and the HTTP channel (until it authenticates its callers) send a principal nobody vouched for, so they stay out of episodic memory as before.
  - The HTTP channel accepts a `conversationId` on `/turn` and `/confirm` only made of letters, digits, `-` and `_`, up to 128 characters once trimmed, and answers `400` otherwise: a client-chosen id can no longer reach another user's wiki notes, forge log lines or break the turn. An existing HTTP conversation whose id has other characters can still be read with `/conversation`, but not continued. `/conversation` keeps opening any session key `/conversations` lists, whatever channel it came from.
  - The model's wiki read tools refuse a per-user id that isn't one path segment, as writes already did.
  - `CHANNEL_API_VERSION` is 2: a channel written for version 1 is refused at load.
  - The first-party channels declare their channel api version as a literal, so an older channel can't claim a newer contract it doesn't implement.

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
