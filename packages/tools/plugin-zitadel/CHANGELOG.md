# @mercury-fw/plugin-zitadel

## 0.3.0

### Minor Changes

- c24de78: A Google Chat sender is recognised as their ZITADEL user.

  - `channel-google-chat` passes the sender's email on as a claim (`claims.email`), on messages and on card clicks, when Google vouches for it: a person's (`HUMAN`) only.
  - `zitadelDirectory` resolves a Google Chat sender to the one active ZITADEL user with that email, verified, whose links to the Google identity provider (`ZITADEL_GOOGLE_IDP_ID`, new and optional) include the sender's own Google account. Without that variable nobody is recognised from Chat. Anyone else on Chat stays unknown and can link their account with a code.
  - `mfw create` lists `ZITADEL_GOOGLE_IDP_ID` in the env example of an app with the ZITADEL directory.

## 0.2.0

### Minor Changes

- 07eb858: ZITADEL as the user directory.

  - `@mercury-fw/plugin-zitadel` exports `zitadelDirectory`. Someone calling with a ZITADEL token is the ZITADEL user the token names, with the role keys of their active role assignments on the project `ZITADEL_PROJECT_ID`. A user ZITADEL doesn't find, or one that isn't active, is unknown. It reads through the zitadel CLI's service user, from code.
  - `mfw create --directory <id>` (`static` or `zitadel`) gives the new app a user directory, and the wizard asks for one.

## 0.1.1

### Patch Changes

- 879be66: A person whose login the service revoked (they ended their session, say) is asked to log in again, instead of getting an error until someone logs them out by hand. The pinned CLIs now renew a revoked token, and when that's refused they report it as a login to redo: zitadel 2.6.1, jira 2.3.2, bitbucket 2.3.2.

## 0.1.0

### Minor Changes

- 2755f61: New plugin: ZITADEL through the `zitadel` CLI.

  - New package `@mercury-fw/plugin-zitadel`. It reads users (by email, username or id), their project roles and identity provider links, organizations and projects, as the person Mercury is talking to, who logs in to ZITADEL through Mercury. Nothing it runs changes ZITADEL.
  - The CLI is pinned at 2.6.0. `mfw credentials setup @mercury-fw/plugin-zitadel` sets up the service user the terminal runs as; with `--user-app` it sets up the Native app people log in through.
  - `mfw create` offers it as `zitadel`.
