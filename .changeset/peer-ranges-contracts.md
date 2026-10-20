---
"@mercury-fw/plugin-jira": patch
"@mercury-fw/plugin-bitbucket": patch
"@mercury-fw/plugin-atlassian-admin": patch
"@mercury-fw/plugin-zitadel": patch
"@mercury-fw/plugin-web-search": patch
"@mercury-fw/channel-http": patch
"@mercury-fw/channel-google-chat": patch
---

Needs the framework at 0.54.0 or later, the version that brings the contract it's written for (plugin contract 5, channel contract 6): the peer range on `@mercury-fw/plugin-types` and `@mercury-fw/cli-engine` (the plugins) or `@mercury-fw/channel-types` (the channels) starts there.
