# @mercury-fw/plugin-bitbucket

Gives a [Mercury](https://github.com/lucabro81/mercury-fw) agent read-only access to Bitbucket pull requests (listing them, reading one), through the `bitbucket` CLI. The pinned binary downloads when the package installs.

```bash
bun add @mercury-fw/plugin-bitbucket
```

In the app: list it in `trustedDependencies` (or Bun skips the install script that downloads the binary) and declare it in `mercury.config.ts`:

```ts
import { bitbucketPlugin } from "@mercury-fw/plugin-bitbucket";

plugins: [bitbucketPlugin],
```

## Credentials

The CLI keeps its login under `~/.config/bitbucket-cli`, and the plugin declares that folder in its `package.json` (`mercury.cliCredentials`) with the commands that set it up. Mercury runs as a Bitbucket OAuth consumer of the workspace (the [bitbucket CLI's README](https://github.com/lucabro81/CLI-monorepo/tree/main/crates/bitbucket) has the steps). Set it up inside the app's container, pasting the consumer's key and secret when the CLI asks:

```bash
mfw credentials setup @mercury-fw/plugin-bitbucket
mfw credentials check @mercury-fw/plugin-bitbucket
```

Coming from a version before 0.2.0: the CLI is now 2.x, which keeps the consumer and each person apart and refuses the old login folder, so the env file's `BITBUCKET_CLI_CONFIG_TAR_B64` isn't read any more. Remove it, then run the setup above once.

MIT
