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
import pkg from "./package.json";

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
  version: pkg.version,
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

The languages the agent speaks, beyond English, and the time zone its people are in. See [Languages](../../concepts/languages/).

| Field | |
|---|---|
| `locales` | The app's language files, by language tag: `{ en, it }`, each imported from `locales/<tag>.json`. A file maps a text's key to its translation; `en` replaces the English texts it names, and also declares the app's own `app.` texts. |
| `defaultLocale` | The language of someone who hasn't picked one and whose app asks for none the agent has: `en` (the default) or a key of `locales`. Any other value stops the agent at startup. |
| `timeZone` | The time zone of someone who hasn't saved one and whose app says none, by its IANA name (`Europe/Rome`): every message reaches the model with the time there. The agent's machine's when left out; a value that isn't a zone's name stops the agent at startup. See [The time where the person is](../../concepts/languages/#the-time-where-the-person-is). |

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

## `version`

The app's own version, shown next to the framework's when a UI asks the HTTP channel which agent it's talking to
(`GET /version` answers `{ "ok": true, "version": "0.65.0", "app": { "version": "1.2.0" } }`). A scaffolded app sets it
to the `version` of its `package.json`, imported at the top of the file.

What it does:

- It shows the version as the app's `package.json` has it, with nothing checked or changed: `1.2.0`, `1.2.0-beta.1` or
  anything else you write there.
- It's read when the app starts, so a new number shows once the app has been rebuilt and restarted (`mfw start`).

What it doesn't do:

- It doesn't move the number. That's up to you: by hand, with [Changesets](https://github.com/changesets/changesets),
  or with a script you run before pushing. An app whose `package.json` still says `0.1.0` shows `0.1.0`.
- It doesn't tell which commit is running, or whether there are changes nobody committed.
- It doesn't hide the number: `GET /version` needs no token, so anyone who reaches the HTTP channel's port sees it.
  Remove the line, or leave the field out, and only the framework's version is shown. An empty string counts as none.
