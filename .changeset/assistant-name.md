---
"@mercury-fw/core": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/cli-engine": minor
"@mercury-fw/kit": minor
"@mercury-fw/cli": minor
"@mercury-fw/channel-http": patch
"@mercury-fw/plugin-jira": patch
---

- `persona.name` is the assistant's name, Mercury when left out. A name that's blank, longer than 40 characters or on more than one line stops the app at startup.
- Every text the model reads refers to the name as `{{assistant}}`, and the core puts the persona's name there: the persona's identity and tone, the system prompt, plugin fragments, skills and tool descriptions. The model no longer takes "Mercury" for its own name when the app calls its assistant something else.
- Where the one acting is the system around the model, the texts say "the system" or "this instance" instead of Mercury: the wiki tools, the cli-engine's errors, the jira skill and its issue lists.
- Plugins get `assistantName` in their `build()` context, and channels in their runtime context, for texts they build while running. The login messages, the linking reply and the HTTP login page name the assistant that way.
- The tools a person runs as the assistant itself are `<tool>AsSelf`, previously `<tool>AsMercury`. The `mercury.act-as-self` roles are unchanged.
- `mfw create` writes the assistant's name as `persona.name`, with `persona/identity.md` and `persona/tone.md` referring to it. An existing app keeps working as it is: to rename its assistant everywhere, add `name` to its persona and write `{{assistant}}` in its persona files.
