---
"@mercury-fw/core": minor
"@mercury-fw/utils": minor
"@mercury-fw/cli-engine": minor
"@mercury-fw/cli": minor
"@mercury-fw/kit": minor
"@mercury-fw/plugin-jira": minor
"@mercury-fw/plugin-bitbucket": minor
"@mercury-fw/plugin-atlassian-admin": minor
---

A CLI's login is set up inside the app's container, no longer carried in the env file.

- A plugin declares in `mercury.cliCredentials` the commands that set its CLI's login up (`setup`, required), check it (`check`) and log an identity out (`logout`), each a binary followed by its arguments.
- `mfw credentials setup <plugin>` runs the declared setup in a one-off container on your terminal, so the CLI writes its login straight onto the credentials volume; `mfw credentials check <plugin>` runs the declared check.
- `mfw credentials reset <plugin> [--user <key>]` runs the declared logout, of the identity Mercury runs as or of one person, instead of deleting the CLI's folder.
- `mfw credentials set` is removed, and the core no longer unpacks `*_CONFIG_TAR_B64` variables at startup: it reports a declared login that isn't set up yet, and still links a login kept outside `~/.config` to the volume.
- A command the model writes with `--user` is refused: which person a CLI acts as is never the model's to pick.
- `cliUserId` (`@mercury-fw/utils`) maps a user key to the id a CLI knows a person by.
- plugin-jira and plugin-bitbucket pin their CLIs at 2.1.0, which keep the service identity and each person apart and refuse the old login folder. After updating, remove the plugin's `*_CONFIG_TAR_B64` line from the env file and run `mfw credentials setup` once; on Jira, Mercury now runs as an Atlassian Service Account.
- plugin-atlassian-admin keeps its CLI at 0.1.2, whose `init` doesn't prompt for the organization key: until it does, write the key from `mfw shell` with `atlassian-admin init --api-key <KEY> --org-id <ORG_ID>` (the plugin's README says so).
