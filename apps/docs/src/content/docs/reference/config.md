---
title: mercury.config.ts
description: Every field of an app's configuration file.
sidebar:
  order: 1
---

`mercury.config.ts`, at the root of the app, declares what the agent is made of. It exports the result of
`defineMercuryConfig`, which does nothing at runtime: it's there so your editor and `tsc` check every field.

```ts title="mercury.config.ts"
import { defineMercuryConfig, envBoolean, envNumber } from "@mercury-fw/core";
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
  model: {
    think: envBoolean("OLLAMA_THINK", true),
    temperature: envNumber("OLLAMA_TEMPERATURE"),
    topP: envNumber("OLLAMA_TOP_P"),
    topK: envNumber("OLLAMA_TOP_K"),
  },
  i18n: { defaultLocale: "it", locales: { en, it } },
  version: pkg.version,
});
```

Settings that change between machines, and secrets, never go here: they go in `.env`, and each piece reads its own
(see [Environment variables](../environment/)). A field whose value changes between machines, like the model's in
[`model`](#model), reads it from `.env` through `envNumber` or `envBoolean`.

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

## `model`

How the chat model (the one in `OLLAMA_MODEL`) generates. It applies to every call on that model: the answers, and
the summaries and checks the agent runs on it in the background. Every field is optional: a field left out isn't
sent to Ollama, so the model's own value applies, the one in its Modelfile.

| Field | |
|---|---|
| `think` | Whether the model reasons before it answers (on when left out). `false` for a model that doesn't support it: Ollama refuses its requests otherwise. |
| `temperature` | How much room the less likely words get, from 0 up. Lower is more predictable: a model that guesses commands instead of reading how to write them guesses less at a low temperature. |
| `topP` | Before each word is picked, only the most likely ones whose probabilities add up to this are kept. Above 0, at most 1. |
| `topK` | Before each word is picked, only this many of the most likely ones are kept. A whole number from 1 up. |

A value out of its range stops the agent at startup, and the log says which field. At startup the log also says what
the model runs with: `[model] qwen3.8:27b: think on, temperature 0.2`, or `server defaults` when nothing is set.

Each value usually comes from `.env`, so the same app can run another model somewhere else with other values. A
scaffolded app writes the section like this:

```ts
import { defineMercuryConfig, envBoolean, envNumber } from "@mercury-fw/core";

model: {
  think: envBoolean("OLLAMA_THINK", true),
  temperature: envNumber("OLLAMA_TEMPERATURE"),
  topP: envNumber("OLLAMA_TOP_P"),
  topK: envNumber("OLLAMA_TOP_K"),
},
```

`envNumber(name, fallback?)` reads a number from the variable, and `envBoolean(name, fallback)` reads `true` or `false`.
An empty or missing variable gives the fallback: with none, as for the three numbers above, the field is left out and
the model's own value applies. Write one to have a default of your own, `envNumber("OLLAMA_TEMPERATURE", 0.2)`. Text
that isn't a number, or isn't `true` or `false`, stops the agent at startup with the variable's name. The variables are
listed in [Environment variables](../environment/#the-model).

## `version`

The app's own version, shown next to the framework's when a UI asks the HTTP channel which agent it's talking to
(`GET /version` answers `{ "ok": true, "version": "0.65.0", "app": { "version": "1.2.0" } }`). A scaffolded app sets it
to the `version` of its `package.json`, imported at the top of the file.

What it does:

- It shows the version as the app's `package.json` has it, with nothing checked: `1.2.0`, `1.2.0-beta.1` or anything
  else you write there, only trimmed of spaces around it.
- It's read when the app starts, so a new number shows once the app has been rebuilt and restarted (`mfw start`).

What it doesn't do:

- It doesn't move the number: it shows whatever the app's `package.json` says.
- It doesn't tell which commit is running, or whether there are changes nobody committed.
- It doesn't hide the number: `GET /version` needs no token, so anyone who reaches the HTTP channel's port sees it.
  Remove the line, or leave the field out, and only the framework's version is shown. An empty string counts as none.
