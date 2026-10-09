---
"@mercury-fw/plugin-zitadel": minor
"@mercury-fw/cli": minor
---

New plugin: ZITADEL through the `zitadel` CLI.

- New package `@mercury-fw/plugin-zitadel`. It reads users (by email, username or id), their project roles and identity provider links, organizations and projects, as the person Mercury is talking to, who logs in to ZITADEL through Mercury. Nothing it runs changes ZITADEL.
- The CLI is pinned at 2.6.0. `mfw credentials setup @mercury-fw/plugin-zitadel` sets up the service user the terminal runs as; with `--user-app` it sets up the Native app people log in through.
- `mfw create` offers it as `zitadel`.
