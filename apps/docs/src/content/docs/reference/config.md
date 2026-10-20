---
title: mercury.config.ts
description: Every field of an app's configuration file.
sidebar:
  order: 1
---

`mercury.config.ts`, at the root of the app, declares what the agent is made of. It exports the result of
`defineMercuryConfig`, which does nothing at runtime: it's there so your editor and `tsc` check every field.

```ts title="mercury.config.ts"
import { defineMercuryConfig } from "@mercury-fw/core";
import { httpChannel } from "@mercury-fw/channel-http";
import { oidcAuth } from "@mercury-fw/auth-oidc";
import { staticDirectory } from "@mercury-fw/directory-static";
import en from "./locales/en.json";
import it from "./locales/it.json";

const name = "Hermes";

export default defineMercuryConfig({
  persona: {
    name,
    identity: `You are ${name}, the platform team's release assistant.`,
    tone: [
      "DO:",
      "- Answer directly, in plain text only.",
      // …
    ].join("\n"),
  },
  plugins: [],
  channels: [httpChannel],
  auth: oidcAuth,
  directory: staticDirectory,
  access: { unknown: "refuse" },
  i18n: { defaultLocale: "it", locales: { en, it } },
});
```

Settings that change between machines, and secrets, never go here: they go in `.env`, and each piece reads its own
(see [Environment variables](../environment/)).

## `plugins`

**Required.** The tool plugins, each active as soon as it's listed. An empty list is fine: the agent talks, with no
tools. A plugin that can't load (a missing setting, a contract version the core doesn't run) is skipped and the log
says why. See [Plugins and skills](../../concepts/plugins/).

A plugin that hands the person lists goes through the formatter, which applies the app's rules to them:

```ts
import { formatterPlugin, formatter } from "@mercury-fw/formatter";
import { jiraPlugin, type JiraDisplays } from "@mercury-fw/plugin-jira";

plugins: [
  formatterPlugin(
    jiraPlugin,
    formatter<JiraDisplays>({
      "issue-list": { item: (issue) => `${issue.key} ${issue.summary}\n${issue.url}`, empty: "No matching issues." },
    }),
  ),
],
```

`formatter` takes one rule per kind of list the plugin declares: the text of each item, or `{ item, empty }` when an
empty list needs its own text. A kind with no rule isn't shown. A rule gets the texts of the person the turn is for as
a second argument, `(issue, t) => …`, and `empty` can be `(t) => t("app.jira.no-issues")` instead of a string: the
app's own keys go under `app.`, written in English in `locales/en.json` and translated in its other language files
(see [`i18n`](#i18n)). `mfw create` writes the Jira rule that way.

## `channels`

The channels people reach the agent through. Left out, the agent has only the terminal. A channel with no settings
stays silent and says so in the log. See [Channels](../../concepts/channels/).

## `auth`

The auth provider that tells a channel like HTTP who is calling: one, or a list tried in order (the first that
recognizes the caller decides). The HTTP channel doesn't start without one. See
[People and roles](../../concepts/people/).

## `directory`

Who the people are, and their roles. Without one, a person is whoever the channel says, with no roles; with one, the
agent talks only to the people it knows, and to nobody while the directory can't be reached.

## `access`

Who may talk to the agent and use what, on top of the directory.

| Field | |
|---|---|
| `unknown` | What to do with someone the directory doesn't know: `"refuse"` (the default) or `"allow"`, taking them as the channel says, with no roles. |
| `plugins` | Restricts a plugin, by name, to people holding one of the roles: `{ jira: { roles: ["support"] } }`. The terminal is exempt. |

What a refused person is told is the text `core.access.unknown`, which a language file changes like any other
(see [`i18n`](#i18n)).

## `i18n`

The languages the agent speaks, beyond English. See [Languages](../../concepts/languages/).

| Field | |
|---|---|
| `locales` | The app's language files, by language tag: `{ en, it }`, each imported from `locales/<tag>.json`. A file maps a text's key to its translation; `en` replaces the English texts it names, and also declares the app's own `app.` texts. |
| `defaultLocale` | The language of someone who hasn't picked one: `en` (the default) or a key of `locales`. Any other value stops the agent at startup. |

## `persona`

Who the assistant is. Every field is optional, and a field left out takes the default.

| Field | |
|---|---|
| `name` | What the assistant is called (`Mercury` by default). At most 40 characters, on one line. |
| `identity` | The opening of the model's instructions: `You are Hermes, …`. |
| `tone` | The closing rules on how to answer. |

A scaffolded app writes the name once, as a `const`, and refers to it in `identity` and `tone`; the tone is written out
in full, one string per line, ready to edit. `{{assistant}}` in any text the model reads also becomes `name`: that's how
the plugins' fragments and skills, written without knowing what the assistant will be called, refer to it.
