---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/channel-http": minor
"@mercury-fw/channel-google-chat": minor
"@mercury-fw/auth-static": minor
"@mercury-fw/directory-static": minor
"@mercury-fw/plugin-atlassian-admin": patch
---

A user directory decides who people are and what they may make Mercury do.

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
