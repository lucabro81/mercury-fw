# @mercury-fw/channel-google-chat

## 0.11.1

### Patch Changes

- c7806ea: README: the setup steps on each service's console follow its official documentation and link it.

  - Google Chat: the Chat app's configuration uses Google's current labels (**Enable interactive features**, **Add a command**, **Slash command name**, a Command ID from 1 to 1000), says Visibility takes up to five people or groups, and links Google's guides to the consent screen, the Pub/Sub quickstart, the Chat API configuration and commands.
  - Jira: links Atlassian's guides to service account credentials and to OAuth 2.0 (3LO) apps, and says the `app.jira.no-issues` text is in `locales/en.json` only in an app created with Jira.
  - Atlassian admin: where an organization admin creates the API key, that it's shown once and expires, and Atlassian's guide.
  - Bitbucket: where a workspace's OAuth consumer is added, and Atlassian's guide.
  - ZITADEL: ZITADEL's guides to a service account's key and to applications.

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.

## 0.11.0

### Minor Changes

- e3eb49d: Stop an answer from Google Chat.

  - Every card still in progress (the receiving card, a reasoning card, a tool's card) has a Stop button, in a section of its own so it's visible without expanding the card; the card's final state has none.
  - `/stop` does the same: the registered slash command, or a message reading exactly `/stop`. With nothing running, the reply says there's nothing to stop.
  - A stop aborts the person's running turn and discards the messages they queued behind it. No partial answer is sent; the card in progress says "Stopped." (or a short message does, when no card was in progress). A command a tool already ran stays done.
  - Only the person who started the answer can stop it: in a shared space, someone else's stop doesn't touch it.
  - New texts: `google-chat.status.stopped`, `google-chat.stop.button`, `google-chat.stop.nothing`.

  Needs the framework at 0.58 or later; an older core stops the model too, but sends the half answer it had. To have Chat suggest `/stop`, and to let it reach the app in a space without a mention, add it in the Chat app's configuration (Cloud Console, Google Chat API → Configuration → Commands): type Slash command, name `/stop`, any free command id.

## 0.10.0

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

## 0.9.0

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

- 6bb8291: Needs the framework at 0.54.0 or later, the version that brings the contract it's written for (plugin contract 5, channel contract 6): the peer range on `@mercury-fw/plugin-types` and `@mercury-fw/cli-engine` (the plugins) or `@mercury-fw/channel-types` (the channels) starts there.

## 0.8.2

### Patch Changes

- edfebb5: - `@mercury-fw/plugin-web-search`: an answer no longer lists its sources twice. When the model writes its own list of sources at the end of the answer, the plugin's `Fonti:` list replaces it, and `web_fetch`'s description tells the model the pages it reads are listed for it.
  - `@mercury-fw/channel-google-chat`: once a choice on a confirmation card is taken, the card shows it ("Scelto: …") instead of the buttons. A click that confirms nothing (expired, or someone else's in a shared space) leaves the card as it is.
  - `@mercury-fw/channel-types`: `confirmReply(outcome)`, the reply to each confirmation outcome, for a channel that resolves a token through `resolveConfirmation`.
  - `@mercury-fw/confirm-engine`: `tryConfirm` answers with `confirmReply`, same texts as before.

## 0.8.1

### Patch Changes

- 4431285: - plugin-web-search README: the minimum core (0.53), the Italian labels the person reads, where a person's list lives and how to edit it, and a config example matching the app `mfw create` writes.
  - channel-google-chat README: the confirmation card has a button per choice, and a choice whose result goes back to the model runs the turn again.

## 0.8.0

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

## 0.7.0

### Minor Changes

- 4184ea6: - `loginLinkText` words a login link the same way on every channel, and the contract states that a login link is shown only to the person it's for.
  - Google Chat shows the login to a service a plugin acts on as the person (Jira, Bitbucket) as a button that opens it, visible only to them: in a shared space it's a private message to whoever asked.
  - `@mercury-fw/channel-google-chat` needs `@mercury-fw/channel-types` 0.46.0 or later.

## 0.6.0

### Minor Changes

- c24de78: A Google Chat sender is recognised as their ZITADEL user.

  - `channel-google-chat` passes the sender's email on as a claim (`claims.email`), on messages and on card clicks, when Google vouches for it: a person's (`HUMAN`) only.
  - `zitadelDirectory` resolves a Google Chat sender to the one active ZITADEL user with that email, verified, whose links to the Google identity provider (`ZITADEL_GOOGLE_IDP_ID`, new and optional) include the sender's own Google account. Without that variable nobody is recognised from Chat. Anyone else on Chat stays unknown and can link their account with a code.
  - `mfw create` lists `ZITADEL_GOOGLE_IDP_ID` in the env example of an app with the ZITADEL directory.

## 0.5.0

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

## 0.4.0

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

## 0.3.0

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

## 0.2.0

### Minor Changes

- 8bed46b: - A turn carries a `Principal` (the person behind it and the provider that vouched for them) instead of the opaque `userId` and `wikiUserId`; the core derives every per-person id from it.
  - Episodic memory follows the principal, not the channel: a session is captured whenever a provider vouched for the person. Google Chat keeps the ids it had; the terminal and the HTTP channel (until it authenticates its callers) send a principal nobody vouched for, so they stay out of episodic memory as before.
  - The HTTP channel accepts a `conversationId` on `/turn` and `/confirm` only made of letters, digits, `-` and `_`, up to 128 characters once trimmed, and answers `400` otherwise: a client-chosen id can no longer reach another user's wiki notes, forge log lines or break the turn. An existing HTTP conversation whose id has other characters can still be read with `/conversation`, but not continued. `/conversation` keeps opening any session key `/conversations` lists, whatever channel it came from.
  - The model's wiki read tools refuse a per-user id that isn't one path segment, as writes already did.
  - `CHANNEL_API_VERSION` is 2: a channel written for version 1 is refused at load.
  - The first-party channels declare their channel api version as a literal, so an older channel can't claim a newer contract it doesn't implement.

## 0.1.3

### Patch Changes

- 5e09c69: - README: a section on connecting a new app to a Chat app that already exists (finding the service account and the subscription, creating a key, `mfw google-chat set-key`).
  - README: how to list and delete the keys the old instances left behind, before the service account reaches its limit of 10.
  - README: `--project` on the `keys create` command of the setup.

## 0.1.2

### Patch Changes

- ab52977: An app created with the Google Chat channel trusts `protobufjs` in `trustedDependencies`, so its install no longer reports that package's postinstall as blocked. The channel's README says to do the same when adding it by hand.

## 0.1.1

### Patch Changes

- 51bd439: `mfw google-chat set-key <key-file> [--subscription <name>]` writes the Google Chat channel's service account key (and its subscription) into the app's env file, the key on one line the way the channel reads it and never printed. The channel's setup uses it in place of the hand-written `sed`/`printf` step.
- de8b1e7: The README walks through setting up the Chat app step by step (gcloud wherever it can, the two Cloud Console pages field by field) and creates the Pub/Sub subscription with no expiration. A new section covers a subscription Pub/Sub deleted after 31 idle days: how to recreate it and give the service account its role back.
