# @mercury-fw/cli-engine

## 0.52.0

### Patch Changes

- Updated dependencies [678c1cc]
  - @mercury-fw/plugin-types@0.52.0
  - @mercury-fw/utils@0.52.0

## 0.51.0

### Patch Changes

- Updated dependencies [b2f8cfb]
  - @mercury-fw/plugin-types@0.51.0
  - @mercury-fw/utils@0.51.0

## 0.50.4

### Patch Changes

- @mercury-fw/plugin-types@0.50.4
- @mercury-fw/utils@0.50.4

## 0.50.3

### Patch Changes

- @mercury-fw/plugin-types@0.50.3
- @mercury-fw/utils@0.50.3

## 0.50.2

### Patch Changes

- @mercury-fw/plugin-types@0.50.2
- @mercury-fw/utils@0.50.2

## 0.50.1

### Patch Changes

- @mercury-fw/plugin-types@0.50.1
- @mercury-fw/utils@0.50.1

## 0.50.0

### Minor Changes

- ae495c7: - The model is told, at the end of every prompt, which lists it already showed in the conversation: each one's ref and the command that built it, never the list itself. It can show one again with `present`, or run the command again for fresh data, instead of retyping it from memory.
  - A list shown in a conversation stays available for `present` as long as the conversation, previously five minutes, at most the ten most recent per conversation.
  - `stashDisplay` takes an optional label, and the cli-engine passes the command that built the list with its number of items.
  - The jira skill points to the lists already shown, and keeps a new search for fresh data.

### Patch Changes

- Updated dependencies [ae495c7]
  - @mercury-fw/plugin-types@0.50.0
  - @mercury-fw/utils@0.50.0

## 0.49.1

### Patch Changes

- @mercury-fw/plugin-types@0.49.1
- @mercury-fw/utils@0.49.1

## 0.49.0

### Patch Changes

- @mercury-fw/plugin-types@0.49.0
- @mercury-fw/utils@0.49.0

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
  - @mercury-fw/utils@0.48.0

## 0.47.1

### Patch Changes

- @mercury-fw/plugin-types@0.47.1
- @mercury-fw/utils@0.47.1

## 0.47.0

### Patch Changes

- @mercury-fw/plugin-types@0.47.0
- @mercury-fw/utils@0.47.0

## 0.46.1

### Patch Changes

- @mercury-fw/plugin-types@0.46.1
- @mercury-fw/utils@0.46.1

## 0.46.0

### Patch Changes

- @mercury-fw/plugin-types@0.46.0
- @mercury-fw/utils@0.46.0

## 0.45.0

### Patch Changes

- @mercury-fw/plugin-types@0.45.0
- @mercury-fw/utils@0.45.0

## 0.44.1

### Patch Changes

- @mercury-fw/plugin-types@0.44.1
- @mercury-fw/utils@0.44.1

## 0.44.0

### Patch Changes

- @mercury-fw/plugin-types@0.44.0
- @mercury-fw/utils@0.44.0

## 0.43.0

### Patch Changes

- @mercury-fw/plugin-types@0.43.0
- @mercury-fw/utils@0.43.0

## 0.42.0

### Patch Changes

- @mercury-fw/plugin-types@0.42.0
- @mercury-fw/utils@0.42.0

## 0.41.0

### Patch Changes

- @mercury-fw/plugin-types@0.41.0
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
  - @mercury-fw/plugin-types@0.40.0
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

### Patch Changes

- @mercury-fw/plugin-types@0.36.0

## 0.35.0

### Patch Changes

- @mercury-fw/plugin-types@0.35.0

## 0.34.0

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
