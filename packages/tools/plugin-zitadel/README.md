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

## As the user directory

The same package exports `zitadelDirectory`: ZITADEL decides who the people talking to Mercury are and what they may make it do, through the project's roles. Declare it next to the OIDC auth provider pointing at the same ZITADEL:

```ts
import { zitadelPlugin, zitadelDirectory } from "@mercury-fw/plugin-zitadel";
import { oidcAuth } from "@mercury-fw/auth-oidc";

auth: oidcAuth,
directory: zitadelDirectory,
```

| Variable | |
|---|---|
| `ZITADEL_PROJECT_ID` | Required. The project whose roles count (`zitadel project list --select projects.projectId,projects.name` lists them). |

It calls the CLI from code, never through the model, as the service user set up above, which only needs `ORG_OWNER_VIEWER` for this. Someone calling the HTTP surface with a ZITADEL token is the ZITADEL user the token's subject names: unknown (and refused, the instance being closed) when ZITADEL doesn't find them or they aren't active, otherwise known with the role keys of their active role assignments on the project. Their email is passed on only when ZITADEL verified it, and their key is `zitadel:<user id>`.

The roles that mean something to Mercury are `mercury.act-as-self` (make Mercury act with its own identity, on every plugin) and `mercury.act-as-self.<plugin>` (on one); create them as roles of the project and assign them to people in ZITADEL's console (the user's **Role Assignments**). Any other role is for the app's `access.plugins`. An answer is kept for five minutes, so a role taken away stops counting within that time.

A Google Chat sender is the ZITADEL user with the sender's email, as long as exactly one active user has it, verified, and that user's identity provider links include the sender's own Google account (Chat's `users/<id>` is the id ZITADEL stores for a Google link). The email alone is only the sender saying who they are; the link is ZITADEL confirming it's the same Google account. This needs Google set up as an identity provider in ZITADEL, and people having signed in through it at least once. Anyone else on Chat is unknown to this directory, and can link their Chat account to the one Mercury knows with a code (see the HTTP channel's `POST /link`).

Identities from other channels aren't resolved by this directory.

People log in on their own: the first time someone asks for something in ZITADEL, Mercury answers that they need to log in, and the [HTTP channel](../../channels/channel-http) shows them the link (it needs `HTTP_SURFACE_PUBLIC_URL`). Mercury never falls back to the service user for them.

MIT
