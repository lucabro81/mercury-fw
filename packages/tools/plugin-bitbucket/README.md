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

The plugin acts as the person: every command runs with the Bitbucket account of whoever Mercury is talking to. On the terminal (`mfw repl`) there's no person, and commands run as the workspace's OAuth consumer.

The CLI keeps every login under `~/.config/bitbucket-cli` (one folder per person, next to the consumer's), and the plugin declares that folder in its `package.json` (`mercury.cliCredentials`) with the commands that set it up. Two consumers are set up once, inside the app's container, pasting each one's key and secret when the CLI asks (the [bitbucket CLI's README](https://github.com/lucabro81/CLI-monorepo/tree/main/crates/bitbucket) has the steps on Bitbucket's side):

- the consumer the terminal runs as;
- the consumer people log in through, whose callback URL is `<HTTP_SURFACE_PUBLIC_URL>/login/callback`: Bitbucket takes no redirect URI, so it always sends the person back to that one.

```bash
mfw credentials setup @mercury-fw/plugin-bitbucket
mfw credentials setup @mercury-fw/plugin-bitbucket --user-app
mfw credentials check @mercury-fw/plugin-bitbucket
```

People log in on their own: the first time someone asks for something in Bitbucket, Mercury answers that they need to log in, and the [HTTP channel](../../channels/channel-http) shows them the link (it needs `HTTP_SURFACE_PUBLIC_URL`). Mercury never falls back to the terminal's consumer for them.

Coming from a version before 0.2.0: the CLI is now 2.x, which keeps the consumer and each person apart and refuses the old login folder, so the env file's `BITBUCKET_CLI_CONFIG_TAR_B64` isn't read any more. Remove it, then run the setup above once.

MIT
