# @mercury-fw/plugin-jira

## 0.6.1

### Patch Changes

- 879be66: A person whose login the service revoked (they ended their session, say) is asked to log in again, instead of getting an error until someone logs them out by hand. The pinned CLIs now renew a revoked token, and when that's refused they report it as a login to redo: zitadel 2.6.1, jira 2.3.2, bitbucket 2.3.2.

## 0.6.0

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

## 0.5.0

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

## 0.4.3

### Patch Changes

- a493d9b: - A plugin whose CLI keeps its login in a folder declares it in its `package.json` (`mercury.cliCredentials`): `{ folder }` under `~/.config`, the default, or `{ path }` anywhere else under the home. Any plugin's CLI gets the login mechanism, not only the first-party ones.
  - The core unpacks each declared login from its env variable onto the credentials volume (`~/.config`) at startup, only when the folder isn't there yet, for the service and the REPL alike; a folder declared elsewhere in the home lives on the volume under `~/.config/mercury-home`, linked from its usual place. It warns about a declared folder with neither the folder nor the variable.
  - `mfw credentials set|reset <plugin>` names the plugin by its package or its CLI's folder (`@mercury-fw/plugin-jira` or `jira-cli`), read from the app's installed plugins; the short name (`jira`) is no longer accepted, and reset asks for the folder's name.
  - `mfw create` no longer writes `docker-entrypoint.sh` or the credentials variables in the env example, and always mounts the `cli-credentials` volume; an existing app's entrypoint keeps working alongside.
  - The generated README explains how a plugin's CLI gets its login without listing plugins.
  - jira, bitbucket and atlassian-admin declare their CLI's login folder; their READMEs point to `mfw credentials set`.

## 0.4.2

### Patch Changes

- 1fa3a97: - Every tool plugin declared in `mercury.config.ts` loads: `MERCURY_CLIS` is no longer read. An app that used it to keep a declared plugin off now gets that plugin on; remove the plugin from the config instead.
  - A new app's env example has no `MERCURY_CLIS`, and its config's comment says every declared plugin and channel is active.
  - A plugin caught in a dependency cycle is always reported at startup.
  - The plugins' READMEs no longer ask to list them in `MERCURY_CLIS`.

## 0.4.1

### Patch Changes

- 9a6bec5: - For a project named informally, the skill has the model search the wiki for the name instead of reading a fixed file a new app doesn't have, then look the project up in Jira.

## 0.4.0

### Minor Changes

- 587a4f7: - The agent can look up Jira users (`user search`) and projects (`project search`).
  - The agent can assign and unassign an issue (`issue assign`), without confirmation like the other edits.
  - The skill shows how to get the account ID that assigning and mentioning in a comment need, and that JQL filters by display name without it.

## 0.3.1

### Patch Changes

- 8df4840: - Installs jira CLI 0.8.2, whose `issue search --help` no longer suggests `currentUser()`.

## 0.3.0

### Minor Changes

- bd643ab: - `JIRA_SITE_URL` is required: without it the plugin doesn't load, and the startup log says which variable to set.
  - Every search result carries `issueCount` and the notes for the model, since the extractor is always there.

## 0.2.1

### Patch Changes

- 0c85d4a: - Installs jira CLI 0.8.1, whose `--help` examples all carry `--select`.
  - The skill no longer warns that the `--help` examples omit `--select`.

## 0.2.0

### Minor Changes

- 1a7d9d2: - The Jira skill gives a working `--select` for every read command: the list select for `issue search`, one for `issue get` and `issue transitions`, and how to count and paginate.
  - The skill no longer says to retry without `--select` or to rely on `--fields`, both refused by the `jira` CLI.
  - When a search result can't be formatted as a list, the note names the exact `--select` to rerun it with.
  - A search that selects issues without their summary (a count, an existence check) returns its data with a note instead of an error.
  - An `issue search` result with an `issues` array carries `issueCount`, the number of issues on that page, and the skill tells the model to read it instead of counting.

## 0.1.2

### Patch Changes

- 60916cb: - The wiki vault's automated commits are authored as `Mercury <mercury@mercury.local>`. Commits written before keep their old address; `git log --author=Mercury` matches both.
  - The Jira issue-list extractor's docs use a generic example site.

## 0.1.1

### Patch Changes

- 0c5bb5b: Dependencies at their latest minor: `ai` 7.0.126, `ai-sdk-ollama` 4.4.0, `zod` 4.6.5, `yaml` 2.9.1, `shell-quote` 1.11.0. A new app from `mfw create` runs Qdrant on its `v1` tag, which follows every 1.x release, instead of a fixed 1.19.0, and gets `@types/bun` `^1.4.2`.
