# @mercury-fw/plugin-zitadel

## 0.5.1

### Patch Changes

- c7806ea: README: the setup steps on each service's console follow its official documentation and link it.

  - Google Chat: the Chat app's configuration uses Google's current labels (**Enable interactive features**, **Add a command**, **Slash command name**, a Command ID from 1 to 1000), says Visibility takes up to five people or groups, and links Google's guides to the consent screen, the Pub/Sub quickstart, the Chat API configuration and commands.
  - Jira: links Atlassian's guides to service account credentials and to OAuth 2.0 (3LO) apps, and says the `app.jira.no-issues` text is in `locales/en.json` only in an app created with Jira.
  - Atlassian admin: where an organization admin creates the API key, that it's shown once and expires, and Atlassian's guide.
  - Bitbucket: where a workspace's OAuth consumer is added, and Atlassian's guide.
  - ZITADEL: ZITADEL's guides to a service account's key and to applications.

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.

## 0.5.0

### Minor Changes

- eac72fa: Every plugin says what it lets the agent do, and the agent can tell. Plugin contract version 6:

  - A plugin declares a `description`: one sentence, in English, for the model, on what it lets the assistant do (`{{assistant}}` stands for its name). How to use it stays in its fragment and skills.
  - The core doesn't load a plugin whose description is missing, blank or more than one line, and the log says why.
  - The system prompt lists the plugins offered to the person, each with its description, right after the persona's identity, and tells the model to answer "what can you do?" from that list. A plugin the person may not use isn't listed; with no plugin offered there's no list.
  - The first-party plugins released with this change carry a description each, are written for contract 6 and need the framework at 0.55.0 or later: the peer range on `@mercury-fw/plugin-types` starts there.

  A plugin written for contract 5 isn't loaded by this core, and the log says why: add a `description` and rebuild it against `PLUGIN_API_VERSION` 6.

## 0.4.0

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

## 0.3.2

### Patch Changes

- 3d73e59: - `auth` in `mercury.config.ts` takes a list of providers as well as one: they're tried in order and the first that recognizes the caller decides who they are. One that fails to load, or fails on a request, is logged and the others still serve; a name taken twice is refused.
  - `createOidcAuth({ name })` is an OIDC provider of its own (`oidc-<name>`), configured by `OIDC_<NAME>_ISSUER` and `OIDC_<NAME>_AUDIENCE`, so an instance can accept several issuers. `oidcAuth` is unchanged.
  - A principal's provider can be `oidc-<name>`; each provider's people keep their own keys.
  - `zitadelDirectory` takes `ZITADEL_AUTH_PROVIDER`, the auth provider whose subjects are its users (default `oidc`).

## 0.3.1

### Patch Changes

- 70a4900: - Needs the `@mercury-fw/*` framework packages at 0.45.0 or later: the earlier floor let an app install versions missing what this package imports.

## 0.3.0

### Minor Changes

- c24de78: A Google Chat sender is recognised as their ZITADEL user.

  - `channel-google-chat` passes the sender's email on as a claim (`claims.email`), on messages and on card clicks, when Google vouches for it: a person's (`HUMAN`) only.
  - `zitadelDirectory` resolves a Google Chat sender to the one active ZITADEL user with that email, verified, whose links to the Google identity provider (`ZITADEL_GOOGLE_IDP_ID`, new and optional) include the sender's own Google account. Without that variable nobody is recognised from Chat. Anyone else on Chat stays unknown and can link their account with a code.
  - `mfw create` lists `ZITADEL_GOOGLE_IDP_ID` in the env example of an app with the ZITADEL directory.

## 0.2.0

### Minor Changes

- 07eb858: ZITADEL as the user directory.

  - `@mercury-fw/plugin-zitadel` exports `zitadelDirectory`. Someone calling with a ZITADEL token is the ZITADEL user the token names, with the role keys of their active role assignments on the project `ZITADEL_PROJECT_ID`. A user ZITADEL doesn't find, or one that isn't active, is unknown. It reads through the zitadel CLI's service user, from code.
  - `mfw create --directory <id>` (`static` or `zitadel`) gives the new app a user directory, and the wizard asks for one.

## 0.1.1

### Patch Changes

- 879be66: A person whose login the service revoked (they ended their session, say) is asked to log in again, instead of getting an error until someone logs them out by hand. The pinned CLIs now renew a revoked token, and when that's refused they report it as a login to redo: zitadel 2.6.1, jira 2.3.2, bitbucket 2.3.2.

## 0.1.0

### Minor Changes

- 2755f61: New plugin: ZITADEL through the `zitadel` CLI.

  - New package `@mercury-fw/plugin-zitadel`. It reads users (by email, username or id), their project roles and identity provider links, organizations and projects, as the person Mercury is talking to, who logs in to ZITADEL through Mercury. Nothing it runs changes ZITADEL.
  - The CLI is pinned at 2.6.0. `mfw credentials setup @mercury-fw/plugin-zitadel` sets up the service user the terminal runs as; with `--user-app` it sets up the Native app people log in through.
  - `mfw create` offers it as `zitadel`.
