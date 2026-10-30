# @mercury-fw/kit

## 0.65.0

### Patch Changes

- Updated dependencies [7a76257]
  - @mercury-fw/channel-types@0.65.0
  - @mercury-fw/plugin-types@0.65.0

## 0.64.0

### Patch Changes

- @mercury-fw/plugin-types@0.64.0
- @mercury-fw/channel-types@0.64.0

## 0.63.0

### Patch Changes

- @mercury-fw/plugin-types@0.63.0
- @mercury-fw/channel-types@0.63.0

## 0.62.0

### Patch Changes

- @mercury-fw/plugin-types@0.62.0
- @mercury-fw/channel-types@0.62.0

## 0.61.0

### Patch Changes

- Updated dependencies [1e7fdeb]
  - @mercury-fw/channel-types@0.61.0
  - @mercury-fw/plugin-types@0.61.0

## 0.60.0

### Patch Changes

- @mercury-fw/plugin-types@0.60.0
- @mercury-fw/channel-types@0.60.0

## 0.59.2

### Patch Changes

- f631dd5: README: a link to the package's page on Mercury's documentation site (https://lucabro81.github.io/mercury-fw/), published from this release on. The HTTP channel's README points to the HTTP API reference there, and the core's memory section to the page that explains it.
- Updated dependencies [f631dd5]
  - @mercury-fw/channel-types@0.59.2
  - @mercury-fw/plugin-types@0.59.2

## 0.59.1

### Patch Changes

- @mercury-fw/plugin-types@0.59.1
- @mercury-fw/channel-types@0.59.1

## 0.59.0

### Patch Changes

- Updated dependencies [7c9a038]
  - @mercury-fw/channel-types@0.59.0
  - @mercury-fw/plugin-types@0.59.0

## 0.58.0

### Patch Changes

- Updated dependencies [e3eb49d]
  - @mercury-fw/channel-types@0.58.0
  - @mercury-fw/plugin-types@0.58.0

## 0.57.0

### Patch Changes

- @mercury-fw/plugin-types@0.57.0
- @mercury-fw/channel-types@0.57.0

## 0.56.0

### Patch Changes

- Updated dependencies [1126106]
  - @mercury-fw/channel-types@0.56.0
  - @mercury-fw/plugin-types@0.56.0

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
  - @mercury-fw/channel-types@0.55.0

## 0.54.0

### Patch Changes

- Updated dependencies [e00ff73]
- Updated dependencies [5015642]
  - @mercury-fw/channel-types@0.54.0
  - @mercury-fw/plugin-types@0.54.0

## 0.53.2

### Patch Changes

- @mercury-fw/plugin-types@0.53.2
- @mercury-fw/channel-types@0.53.2

## 0.53.1

### Patch Changes

- Updated dependencies [edfebb5]
  - @mercury-fw/channel-types@0.53.1
  - @mercury-fw/plugin-types@0.53.1

## 0.53.0

### Patch Changes

- Updated dependencies [56e4ed5]
- Updated dependencies [c83b129]
  - @mercury-fw/plugin-types@0.53.0
  - @mercury-fw/channel-types@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies [678c1cc]
  - @mercury-fw/plugin-types@0.52.0
  - @mercury-fw/channel-types@0.52.0

## 0.51.0

### Patch Changes

- Updated dependencies [b2f8cfb]
  - @mercury-fw/plugin-types@0.51.0
  - @mercury-fw/channel-types@0.51.0

## 0.50.4

### Patch Changes

- @mercury-fw/plugin-types@0.50.4
- @mercury-fw/channel-types@0.50.4

## 0.50.3

### Patch Changes

- @mercury-fw/plugin-types@0.50.3
- @mercury-fw/channel-types@0.50.3

## 0.50.2

### Patch Changes

- @mercury-fw/plugin-types@0.50.2
- @mercury-fw/channel-types@0.50.2

## 0.50.1

### Patch Changes

- @mercury-fw/plugin-types@0.50.1
- @mercury-fw/channel-types@0.50.1

## 0.50.0

### Patch Changes

- Updated dependencies [ae495c7]
  - @mercury-fw/plugin-types@0.50.0
  - @mercury-fw/channel-types@0.50.0

## 0.49.1

### Patch Changes

- @mercury-fw/plugin-types@0.49.1
- @mercury-fw/channel-types@0.49.1

## 0.49.0

### Patch Changes

- Updated dependencies [b7438a6]
  - @mercury-fw/channel-types@0.49.0
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
  - @mercury-fw/channel-types@0.48.0

## 0.47.1

### Patch Changes

- @mercury-fw/plugin-types@0.47.1
- @mercury-fw/channel-types@0.47.1

## 0.47.0

### Patch Changes

- Updated dependencies [3d73e59]
  - @mercury-fw/channel-types@0.47.0
  - @mercury-fw/plugin-types@0.47.0

## 0.46.1

### Patch Changes

- @mercury-fw/plugin-types@0.46.1
- @mercury-fw/channel-types@0.46.1

## 0.46.0

### Patch Changes

- Updated dependencies [4184ea6]
  - @mercury-fw/channel-types@0.46.0
  - @mercury-fw/plugin-types@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [812c9c5]
  - @mercury-fw/channel-types@0.45.0
  - @mercury-fw/plugin-types@0.45.0

## 0.44.1

### Patch Changes

- @mercury-fw/plugin-types@0.44.1
- @mercury-fw/channel-types@0.44.1

## 0.44.0

### Patch Changes

- Updated dependencies [2c63bbf]
  - @mercury-fw/channel-types@0.44.0
  - @mercury-fw/plugin-types@0.44.0

## 0.43.0

### Patch Changes

- @mercury-fw/plugin-types@0.43.0
- @mercury-fw/channel-types@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [a7f2f13]
  - @mercury-fw/channel-types@0.42.0
  - @mercury-fw/plugin-types@0.42.0

## 0.41.0

### Patch Changes

- @mercury-fw/plugin-types@0.41.0
- @mercury-fw/channel-types@0.41.0

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

- @mercury-fw/plugin-types@0.39.0
- @mercury-fw/channel-types@0.39.0

## 0.38.1

### Patch Changes

- @mercury-fw/plugin-types@0.38.1
- @mercury-fw/channel-types@0.38.1

## 0.38.0

### Patch Changes

- @mercury-fw/plugin-types@0.38.0
- @mercury-fw/channel-types@0.38.0

## 0.37.0

### Patch Changes

- @mercury-fw/plugin-types@0.37.0
- @mercury-fw/channel-types@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [521db42]
  - @mercury-fw/channel-types@0.36.0
  - @mercury-fw/plugin-types@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [8d3e5af]
  - @mercury-fw/channel-types@0.35.0
  - @mercury-fw/plugin-types@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [8bed46b]
  - @mercury-fw/channel-types@0.34.0
  - @mercury-fw/plugin-types@0.34.0

## 0.33.0

### Minor Changes

- a493d9b: - A plugin whose CLI keeps its login in a folder declares it in its `package.json` (`mercury.cliCredentials`): `{ folder }` under `~/.config`, the default, or `{ path }` anywhere else under the home. Any plugin's CLI gets the login mechanism, not only the first-party ones.
  - The core unpacks each declared login from its env variable onto the credentials volume (`~/.config`) at startup, only when the folder isn't there yet, for the service and the REPL alike; a folder declared elsewhere in the home lives on the volume under `~/.config/mercury-home`, linked from its usual place. It warns about a declared folder with neither the folder nor the variable.
  - `mfw credentials set|reset <plugin>` names the plugin by its package or its CLI's folder (`@mercury-fw/plugin-jira` or `jira-cli`), read from the app's installed plugins; the short name (`jira`) is no longer accepted, and reset asks for the folder's name.
  - `mfw create` no longer writes `docker-entrypoint.sh` or the credentials variables in the env example, and always mounts the `cli-credentials` volume; an existing app's entrypoint keeps working alongside.
  - The generated README explains how a plugin's CLI gets its login without listing plugins.
  - jira, bitbucket and atlassian-admin declare their CLI's login folder; their READMEs point to `mfw credentials set`.

### Patch Changes

- @mercury-fw/plugin-types@0.33.0
- @mercury-fw/channel-types@0.33.0

## 0.32.0

### Patch Changes

- @mercury-fw/plugin-types@0.32.0
- @mercury-fw/channel-types@0.32.0

## 0.31.1

### Patch Changes

- @mercury-fw/plugin-types@0.31.1
- @mercury-fw/channel-types@0.31.1

## 0.31.0

### Patch Changes

- @mercury-fw/plugin-types@0.31.0
- @mercury-fw/channel-types@0.31.0

## 0.30.0

### Patch Changes

- @mercury-fw/plugin-types@0.30.0
- @mercury-fw/channel-types@0.30.0

## 0.29.4

### Patch Changes

- @mercury-fw/plugin-types@0.29.4
- @mercury-fw/channel-types@0.29.4

## 0.29.3

### Patch Changes

- @mercury-fw/plugin-types@0.29.3
- @mercury-fw/channel-types@0.29.3

## 0.29.2

### Patch Changes

- @mercury-fw/plugin-types@0.29.2
- @mercury-fw/channel-types@0.29.2

## 0.29.1

### Patch Changes

- @mercury-fw/plugin-types@0.29.1
- @mercury-fw/channel-types@0.29.1

## 0.29.0

### Patch Changes

- @mercury-fw/plugin-types@0.29.0
- @mercury-fw/channel-types@0.29.0

## 0.28.4

### Patch Changes

- @mercury-fw/plugin-types@0.28.4
- @mercury-fw/channel-types@0.28.4

## 0.28.3

### Patch Changes

- @mercury-fw/plugin-types@0.28.3
- @mercury-fw/channel-types@0.28.3

## 0.28.2

### Patch Changes

- @mercury-fw/plugin-types@0.28.2
- @mercury-fw/channel-types@0.28.2

## 0.28.1

### Patch Changes

- @mercury-fw/plugin-types@0.28.1
- @mercury-fw/channel-types@0.28.1

## 0.28.0

### Patch Changes

- @mercury-fw/plugin-types@0.28.0
- @mercury-fw/channel-types@0.28.0

## 0.27.1

### Patch Changes

- @mercury-fw/plugin-types@0.27.1
- @mercury-fw/channel-types@0.27.1

## 0.27.0

### Patch Changes

- @mercury-fw/plugin-types@0.27.0
- @mercury-fw/channel-types@0.27.0

## 0.26.0

### Patch Changes

- @mercury-fw/plugin-types@0.26.0
- @mercury-fw/channel-types@0.26.0

## 0.25.1

### Patch Changes

- @mercury-fw/plugin-types@0.25.1
- @mercury-fw/channel-types@0.25.1

## 0.25.0

### Patch Changes

- @mercury-fw/plugin-types@0.25.0
- @mercury-fw/channel-types@0.25.0
