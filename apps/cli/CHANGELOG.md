# @mercury-fw/cli

## 0.42.0

### Patch Changes

- Updated dependencies [a7f2f13]
  - @mercury-fw/core@0.42.0
  - @mercury-fw/utils@0.42.0

## 0.41.0

### Minor Changes

- 2755f61: New plugin: ZITADEL through the `zitadel` CLI.

  - New package `@mercury-fw/plugin-zitadel`. It reads users (by email, username or id), their project roles and identity provider links, organizations and projects, as the person Mercury is talking to, who logs in to ZITADEL through Mercury. Nothing it runs changes ZITADEL.
  - The CLI is pinned at 2.6.0. `mfw credentials setup @mercury-fw/plugin-zitadel` sets up the service user the terminal runs as; with `--user-app` it sets up the Native app people log in through.
  - `mfw create` offers it as `zitadel`.

### Patch Changes

- @mercury-fw/core@0.41.0
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
  - @mercury-fw/core@0.40.0
  - @mercury-fw/utils@0.40.0

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
  - @mercury-fw/core@0.39.0
  - @mercury-fw/utils@0.39.0

## 0.38.1

### Patch Changes

- 972a17f: - `mfw local-packages` and `mfw create --local-packages` name each tarball in `.packs/` after its content, so a package repacked at the same version is installed anew instead of kept from Bun's cache or refused by the lockfile's integrity check
  - @mercury-fw/core@0.38.1
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

- Updated dependencies [de1ee52]
  - @mercury-fw/core@0.38.0
  - @mercury-fw/utils@0.38.0

## 0.37.0

### Minor Changes

- fbaa7aa: The admin panel is gone.

  - Breaking, `@mercury-fw/core`: `composeMercury` no longer returns `startAdmin`, and `ADMIN_PANEL_ENABLED`/`ADMIN_PANEL_PORT` do nothing. An existing app removes the two lines of its `src/index.ts` that start and stop it (`const adminServer = app.startAdmin();` and `adminServer?.stop();`).
  - New apps don't start it.
  - What it showed is in the HTTP surface's read routes, scoped to the caller, and in `mfw vault` / `mfw memory` for the operator.

### Patch Changes

- Updated dependencies [fbaa7aa]
  - @mercury-fw/core@0.37.0
  - @mercury-fw/utils@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [521db42]
  - @mercury-fw/core@0.36.0
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
  - @mercury-fw/core@0.35.0
  - @mercury-fw/utils@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [8bed46b]
  - @mercury-fw/core@0.34.0
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
  - @mercury-fw/core@0.33.0

## 0.32.0

### Minor Changes

- 1fa3a97: - Every tool plugin declared in `mercury.config.ts` loads: `MERCURY_CLIS` is no longer read. An app that used it to keep a declared plugin off now gets that plugin on; remove the plugin from the config instead.
  - A new app's env example has no `MERCURY_CLIS`, and its config's comment says every declared plugin and channel is active.
  - A plugin caught in a dependency cycle is always reported at startup.
  - The plugins' READMEs no longer ask to list them in `MERCURY_CLIS`.

### Patch Changes

- Updated dependencies [1fa3a97]
  - @mercury-fw/core@0.32.0

## 0.31.1

### Patch Changes

- Updated dependencies [7926aa2]
  - @mercury-fw/core@0.31.1

## 0.31.0

### Minor Changes

- 6ae8133: - `mfw local-packages <folder>` makes an app install `@mercury-fw/*` packages from local tarballs (`bun pm pack`) instead of the registry, transitive dependencies included; `--off` goes back to the registry.
  - `mfw e2e` runs end-to-end tests against an app's real model through its REPL: cases of turns with checks on the tool calls and the answer, repeated runs, results kept in `e2e/results/`.
  - Test files declare their cases with `e2e()` from `@mercury-fw/cli/e2e`.
  - A new app's Dockerfile copies `.packs/` when present, and its `.gitignore` leaves out `.packs/` and `e2e/results/`.
  - In the REPL, `/dump` after a confirmation no longer writes the turn before it.

### Patch Changes

- Updated dependencies [6ae8133]
  - @mercury-fw/core@0.31.0

## 0.30.0

### Minor Changes

- 238d4dc: - `mfw create` runs `bun install` in the new app, showing its output as it goes (`--no-install` to skip it).
  - `mfw create` creates a git repository on `main` with a first commit, lockfile included (`--no-git` to skip it); inside another repository it is skipped, and when git refuses a step or is missing, the message reports why and lists the commands to finish by hand.
  - `mfw create` adds `origin` when given one, in the wizard or with `--git-remote`; nothing is pushed.
  - The message at the end of `mfw create` lists what each step did and only the steps left to run.

### Patch Changes

- @mercury-fw/core@0.30.0

## 0.29.4

### Patch Changes

- Updated dependencies [63f3da2]
  - @mercury-fw/core@0.29.4

## 0.29.3

### Patch Changes

- bd643ab: - A scaffolded app with Jira marks `JIRA_SITE_URL` as required in its env example.
  - @mercury-fw/core@0.29.3

## 0.29.2

### Patch Changes

- cc31536: - `mfw create` ends by saying that, without a global `mfw`, the app's commands run as `bunx mfw <command>`, and lists the global install as an optional step.
  - @mercury-fw/core@0.29.2

## 0.29.1

### Patch Changes

- Updated dependencies [60916cb]
  - @mercury-fw/core@0.29.1

## 0.29.0

### Minor Changes

- e498dad: `mfw` is meant to be installed globally (`bun add -g @mercury-fw/cli`) and used as a plain command. Inside an app, a global `mfw` at another version hands the command over to the app's own CLI, so the app's commands always match its framework. `mfw upgrade` installs the registry's latest globally, and `mfw create` run by a stale `mfw` says to. The CLI's messages, the generated app and the docs say `mfw` instead of `bunx mfw`.

### Patch Changes

- @mercury-fw/core@0.29.0

## 0.28.4

### Patch Changes

- 65e78fe: `mfw create` (and `bun create mercury-agent`) checks the registry for a newer `@mercury-fw/cli` first, and when it's behind, as a copy left in Bun's bunx cache can be, it runs the same command through the newer version instead of writing an outdated app.
  - @mercury-fw/core@0.28.4

## 0.28.3

### Patch Changes

- 5175e10: An app created with the HTTP channel publishes the surface's port on the host (`HTTP_SURFACE_PORT`, 4100 when unset), so it's reachable from outside the container; its README says where it listens and that it has no authentication.
  - @mercury-fw/core@0.28.3

## 0.28.2

### Patch Changes

- 0c5bb5b: Dependencies at their latest minor: `ai` 7.0.126, `ai-sdk-ollama` 4.4.0, `zod` 4.6.5, `yaml` 2.9.1, `shell-quote` 1.11.0. A new app from `mfw create` runs Qdrant on its `v1` tag, which follows every 1.x release, instead of a fixed 1.19.0, and gets `@types/bun` `^1.4.2`.
- Updated dependencies [0c5bb5b]
  - @mercury-fw/core@0.28.2

## 0.28.1

### Patch Changes

- ab52977: An app created with the Google Chat channel trusts `protobufjs` in `trustedDependencies`, so its install no longer reports that package's postinstall as blocked. The channel's README says to do the same when adding it by hand.
  - @mercury-fw/core@0.28.1

## 0.28.0

### Minor Changes

- 51bd439: `mfw google-chat set-key <key-file> [--subscription <name>]` writes the Google Chat channel's service account key (and its subscription) into the app's env file, the key on one line the way the channel reads it and never printed. The channel's setup uses it in place of the hand-written `sed`/`printf` step.

### Patch Changes

- @mercury-fw/core@0.28.0

## 0.27.1

### Patch Changes

- Updated dependencies [2c0e020]
  - @mercury-fw/core@0.27.1

## 0.27.0

### Minor Changes

- d2a6be5: - A scaffolded app with tool plugins gets a `docker-entrypoint.sh`: at the first start without a CLI's config folder on the credentials volume, it unpacks that CLI's variable from the env file there, then starts the service. What the CLI refreshes afterwards stays on the volume.
  - The scaffolded env example lists each tool plugin's credentials variable, and the README explains the flow.
  - `mfw credentials set <plugin>` packs a CLI's config folder (`~/.config/<cli>`, or `--from <dir>`) into its variable in the app's env file, never printing it; `--print` prints the line to paste elsewhere.
  - `mfw credentials reset <plugin>` clears a CLI's folder from the credentials volume after you type the plugin's name, so a corrected variable is unpacked at the next start.

### Patch Changes

- @mercury-fw/core@0.27.0

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

- Updated dependencies [8b92abb]
  - @mercury-fw/core@0.26.0

## 0.25.1

### Patch Changes

- 5613e5e: - Mercury starts even when Qdrant isn't answering yet: the memory collections are set up in the background and retried until Qdrant is reachable, instead of crashing the process at startup.
  - A new session's context primer goes on without the last-session recap when Qdrant doesn't answer, instead of failing the turn.
  - The scaffolded app's `docker-compose.yml` restarts the app service unless it was stopped.
- Updated dependencies [5613e5e]
  - @mercury-fw/core@0.25.1

## 0.25.0

### Patch Changes

- Updated dependencies [c114e34]
  - @mercury-fw/core@0.25.0
