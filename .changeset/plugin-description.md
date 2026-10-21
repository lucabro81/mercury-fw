---
"@mercury-fw/plugin-types": minor
"@mercury-fw/kit": minor
"@mercury-fw/core": minor
"@mercury-fw/plugin-jira": minor
"@mercury-fw/plugin-bitbucket": minor
"@mercury-fw/plugin-atlassian-admin": minor
"@mercury-fw/plugin-zitadel": minor
"@mercury-fw/plugin-web-search": minor
---

Every plugin says what it lets the agent do, and the agent can tell. Plugin contract version 6:

- A plugin declares a `description`: one sentence, in English, for the model, on what it lets the assistant do (`{{assistant}}` stands for its name). How to use it stays in its fragment and skills.
- The core doesn't load a plugin whose description is missing or blank, and the log says why.
- The system prompt lists the plugins offered to the person, each with its description, right after the persona's identity, and tells the model to answer "what can you do?" from that list. A plugin the person may not use isn't listed; with no plugin offered there's no list.
- The first-party plugins released with this change carry a description each, are written for contract 6 and need the framework at 0.55.0 or later: the peer range on `@mercury-fw/plugin-types` starts there.

A plugin written for contract 5 isn't loaded by this core, and the log says why: add a `description` and rebuild it against `PLUGIN_API_VERSION` 6.
