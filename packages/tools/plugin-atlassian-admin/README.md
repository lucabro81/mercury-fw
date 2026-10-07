# @mercury-fw/plugin-atlassian-admin

Lets a [Mercury](https://github.com/lucabro81/mercury-fw) agent look up users in an Atlassian organization, through the `atlassian-admin` CLI (read-only). The pinned binary downloads when the package installs.

```bash
bun add @mercury-fw/plugin-atlassian-admin
```

In the app: list it in `trustedDependencies` (or Bun skips the install script that downloads the binary) and declare it in `mercury.config.ts`:

```ts
import { atlassianAdminPlugin } from "@mercury-fw/plugin-atlassian-admin";

plugins: [atlassianAdminPlugin],
```

## Credentials

The CLI keeps its login, an organization API key, under `~/.config/atlassian-admin-cli`, and the plugin declares that folder in its `package.json` (`mercury.cliCredentials`) with the commands that set it up. It's set up inside the app's container:

```bash
mfw credentials setup @mercury-fw/plugin-atlassian-admin
mfw credentials check @mercury-fw/plugin-atlassian-admin
```

The pinned CLI doesn't prompt for the key yet (it refuses to, so the key never lands in scrollback, and only takes it as flags), so for now `setup` prints how to write it. Until it does, open a shell in the app's container with `mfw shell` and run `atlassian-admin init --api-key <KEY> --org-id <ORG_ID>` there.

Coming from a version before 0.2.0: the env file's `ATLASSIAN_ADMIN_CLI_CONFIG_TAR_B64` isn't read any more. Remove it, then set the key up as above once.

MIT
