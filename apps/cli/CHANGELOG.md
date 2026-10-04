# @mercury-fw/cli

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
