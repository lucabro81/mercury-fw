---
"@mercury-fw/channel-google-chat": patch
"@mercury-fw/plugin-jira": patch
"@mercury-fw/plugin-atlassian-admin": patch
"@mercury-fw/plugin-bitbucket": patch
"@mercury-fw/plugin-zitadel": patch
---

README: the setup steps on each service's console follow its official documentation and link it.

- Google Chat: the Chat app's configuration uses Google's current labels (**Enable interactive features**, **Add a command**, **Slash command name**, a Command ID from 1 to 1000), says Visibility takes up to five people or groups, and links Google's guides to the consent screen, the Pub/Sub quickstart, the Chat API configuration and commands.
- Jira: links Atlassian's guides to service account credentials and to OAuth 2.0 (3LO) apps, and says the `app.jira.no-issues` text is in `locales/en.json` only in an app created with Jira.
- Atlassian admin: where an organization admin creates the API key, that it's shown once and expires, and Atlassian's guide.
- Bitbucket: where a workspace's OAuth consumer is added, and Atlassian's guide.
- ZITADEL: ZITADEL's guides to a service account's key and to applications.
