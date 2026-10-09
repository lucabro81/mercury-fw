# @mercury-fw/plugin-atlassian-admin

## 0.3.1

### Patch Changes

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

## 0.3.0

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

## 0.2.0

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

## 0.1.2

### Patch Changes

- a493d9b: - A plugin whose CLI keeps its login in a folder declares it in its `package.json` (`mercury.cliCredentials`): `{ folder }` under `~/.config`, the default, or `{ path }` anywhere else under the home. Any plugin's CLI gets the login mechanism, not only the first-party ones.
  - The core unpacks each declared login from its env variable onto the credentials volume (`~/.config`) at startup, only when the folder isn't there yet, for the service and the REPL alike; a folder declared elsewhere in the home lives on the volume under `~/.config/mercury-home`, linked from its usual place. It warns about a declared folder with neither the folder nor the variable.
  - `mfw credentials set|reset <plugin>` names the plugin by its package or its CLI's folder (`@mercury-fw/plugin-jira` or `jira-cli`), read from the app's installed plugins; the short name (`jira`) is no longer accepted, and reset asks for the folder's name.
  - `mfw create` no longer writes `docker-entrypoint.sh` or the credentials variables in the env example, and always mounts the `cli-credentials` volume; an existing app's entrypoint keeps working alongside.
  - The generated README explains how a plugin's CLI gets its login without listing plugins.
  - jira, bitbucket and atlassian-admin declare their CLI's login folder; their READMEs point to `mfw credentials set`.

## 0.1.1

### Patch Changes

- 1fa3a97: - Every tool plugin declared in `mercury.config.ts` loads: `MERCURY_CLIS` is no longer read. An app that used it to keep a declared plugin off now gets that plugin on; remove the plugin from the config instead.
  - A new app's env example has no `MERCURY_CLIS`, and its config's comment says every declared plugin and channel is active.
  - A plugin caught in a dependency cycle is always reported at startup.
  - The plugins' READMEs no longer ask to list them in `MERCURY_CLIS`.

## 0.1.1

### Patch Changes

- 1fa3a97: - Every tool plugin declared in `mercury.config.ts` loads: `MERCURY_CLIS` is no longer read. An app that used it to keep a declared plugin off now gets that plugin on; remove the plugin from the config instead.
  - A new app's env example has no `MERCURY_CLIS`, and its config's comment says every declared plugin and channel is active.
  - A plugin caught in a dependency cycle is always reported at startup.
  - The plugins' READMEs no longer ask to list them in `MERCURY_CLIS`.
