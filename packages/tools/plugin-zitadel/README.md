# @mercury-fw/plugin-zitadel

Gives a [Mercury](https://github.com/lucabro81/mercury-fw) agent read access to a [ZITADEL](https://zitadel.com) instance through the `zitadel` CLI: users (searched by email or username, or read by id), their project roles and identity provider links, organizations and projects. The pinned binary downloads when the package installs.

```bash
bun add @mercury-fw/plugin-zitadel
```

In the app: list it in `trustedDependencies` (or Bun skips the install script that downloads the binary) and declare it in `mercury.config.ts`:

```ts
import { zitadelPlugin } from "@mercury-fw/plugin-zitadel";

plugins: [zitadelPlugin],
```

Nothing it runs changes ZITADEL. Administrative commands come with the CLI's, and the destructive ones will ask for confirmation.

## Credentials

The plugin acts as the person: every command runs with the ZITADEL account of whoever Mercury is talking to, so ZITADEL decides what they can read. On the terminal (`mfw repl`) there's no person, and commands run as the instance's service user.

The CLI keeps every login under `~/.config/zitadel-cli` (one folder per person, next to the service user's), and the plugin declares that folder in its `package.json` (`mercury.cliCredentials`) with the commands that set it up. Two things are set up once, inside the app's container, answering what the CLI asks (the [zitadel CLI's README](https://github.com/lucabro81/CLI-monorepo/tree/main/crates/zitadel) has the steps on ZITADEL's side):

- the service user the terminal runs as: the CLI asks for the instance URL and the service user's key JSON, pasted whole (hidden). `ORG_OWNER_VIEWER` on the organization is enough to read users, their project roles and their identity provider links;
- the Native app people log in through, with `<HTTP_SURFACE_PUBLIC_URL>/login/callback` among its redirect URIs: the CLI asks for its client id.

```bash
mfw credentials setup @mercury-fw/plugin-zitadel
mfw credentials setup @mercury-fw/plugin-zitadel --user-app
mfw credentials check @mercury-fw/plugin-zitadel
```

People log in on their own: the first time someone asks for something in ZITADEL, Mercury answers that they need to log in, and the [HTTP channel](../../channels/channel-http) shows them the link (it needs `HTTP_SURFACE_PUBLIC_URL`). Mercury never falls back to the service user for them.

MIT
