---
"@mercury-fw/channel-types": minor
"@mercury-fw/channel-google-chat": minor
---

- `loginLinkText` words a login link the same way on every channel, and the contract states that a login link is shown only to the person it's for.
- Google Chat shows the login to a service a plugin acts on as the person (Jira, Bitbucket) as a button that opens it, visible only to them: in a shared space it's a private message to whoever asked.
- `@mercury-fw/channel-google-chat` needs `@mercury-fw/channel-types` 0.46.0 or later.
