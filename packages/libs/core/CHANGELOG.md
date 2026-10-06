# @mercury-fw/core

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
