---
name: zitadel
description: Read a ZITADEL instance via the zitadelCommand tool — who the user is, users by email, username or id, a user's project roles and linked identity providers, organizations and projects. Load this before running any zitadel command.
---

You have access to the zitadelCommand tool, which runs the `zitadel` CLI against the organization's ZITADEL instance. It only reads: nothing it runs changes ZITADEL.

HOW THE CLI PRINTS (read this first):
- `user search`, `user authorizations`, `user idp-links`, `organization list` and `project list` REQUIRE `--select`: without it the CLI refuses to print and reports the response's top-level fields instead. Start from exactly the commands below, adding paths only for fields the question needs.
- `--select` takes comma-separated dot-notation paths from the root of the response; arrays are projected element by element, so `result.userId` gives every user's id.
- Never use `--select-all`: the commands below already name the useful paths.
- Who the user is: `zitadel auth whoami` (prints in full: `user.id`, `user.userName`, `user.loginNames`, `user.human.profile`, `user.human.email`).
- Organizations: `zitadel organization list --select result.id,result.name,result.state,result.primaryDomain`
- Projects: `zitadel project list --select projects.projectId,projects.name,pagination.totalResult` (`--organization-id ORG_ID` narrows it to one organization, `--name TEXT` to a name).
- A person by email: `zitadel user search --email-exact jane@example.com --select result.userId,result.username,result.state,result.human.profile.displayName,result.human.email.isVerified` (`--email TEXT` and `--username TEXT` match a fragment instead).
- A person by id: `zitadel user get USER_ID --select user.username,user.state,user.human.profile.displayName,user.human.email.email`
- A person's project roles: `zitadel user authorizations USER_ID --select authorizations.project.name,authorizations.roles.key,authorizations.state` (`--project-id PROJECT_ID` for one project). The user id comes from `user search` or `auth whoami`, never from a name.
- A person's linked identity providers (e.g. Google): `zitadel user idp-links USER_ID --select result.idpName,result.userName`
- An empty object `{}`, or a result with only `details` or `pagination`, means nothing matched or the user's account can't see it: say so, don't retry with other paths.

DO:
- Call zitadelCommand with `command` set to the exact command line you would type in a terminal — quote values containing spaces, exactly like a real shell.
- Use zitadelCommand to get real data — never invent users, ids or roles.
- Every zitadelCommand runs as the person you're talking to, with their own ZITADEL account: they see exactly what that account can, and `auth whoami` is them. If a list comes back empty, it's usually because their account has no access to it: tell them that instead of guessing.
- If a result says the user isn't logged in to ZITADEL yet, tell them to log in with the link shown to them and ask again afterwards. Never write a login link yourself, and don't retry the command until they're back.
- Use --help on a subcommand only for a flag not shown above.
