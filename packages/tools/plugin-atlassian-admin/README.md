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

The CLI asks for the organization id and for the key, which it reads without echoing it.

## Who can use it

The key is the organization's, the same whoever asks: through it anyone could look up any account in the organization, profile and email included. So the plugin acts as Mercury itself, not as the person, and only someone allowed to make Mercury act as itself may use it: a person holding the role `mercury.act-as-self.atlassian-admin` (or `mercury.act-as-self`, for every plugin) in the app's directory, and the terminal (`mfw repl`). Everyone else doesn't see it, its skill included, and every lookup made for someone is logged with who asked.

Coming from a version before 0.2.0: the env file's `ATLASSIAN_ADMIN_CLI_CONFIG_TAR_B64` isn't read any more. Remove it, then set the key up as above once.

MIT
