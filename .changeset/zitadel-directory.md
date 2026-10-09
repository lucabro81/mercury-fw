---
"@mercury-fw/plugin-zitadel": minor
"@mercury-fw/cli": minor
---

ZITADEL as the user directory.

- `@mercury-fw/plugin-zitadel` exports `zitadelDirectory`. Someone calling with a ZITADEL token is the ZITADEL user the token names, with the role keys of their active role assignments on the project `ZITADEL_PROJECT_ID`. A user ZITADEL doesn't find, or one that isn't active, is unknown. It reads through the zitadel CLI's service user, from code.
- `mfw create --directory <id>` (`static` or `zitadel`) gives the new app a user directory, and the wizard asks for one.
