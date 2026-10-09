# @mercury-fw/auth-static

## 0.2.0

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

## 0.1.0

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
