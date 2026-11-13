---
title: mercury.config.ts
description: Every field of an app's configuration file.
sidebar:
  order: 1
---

`mercury.config.ts`, at the root of the app, declares what the agent is made of. It exports the result of
`defineMercuryConfig`, which does nothing at runtime: it's there so your editor and `tsc` check every field.

```ts title="mercury.config.ts"
import { defineMercuryConfig, envBoolean, envNumber, ollamaEmbedding, ollamaModel } from "@mercury-fw/core";
import { httpChannel } from "@mercury-fw/channel-http";
import { oidcAuth } from "@mercury-fw/auth-oidc";
import { staticDirectory } from "@mercury-fw/directory-static";
import en from "./locales/en.json";
import it from "./locales/it.json";
import pkg from "./package.json";
import { jsonlTraces } from "@mercury-fw/trace-jsonl";
import { qdrantConversations, qdrantIndex } from "@mercury-fw/store-qdrant";
import { conversationWindow } from "@mercury-fw/conversation-window";

const name = "Hermes";
const conversation = conversationWindow();

const main = ollamaModel(process.env.OLLAMA_MODEL, {
  think: envBoolean("OLLAMA_THINK", true),
  temperature: envNumber("OLLAMA_TEMPERATURE"),
  topP: envNumber("OLLAMA_TOP_P"),
  topK: envNumber("OLLAMA_TOP_K"),
  capacity: envNumber("OLLAMA_CAPACITY"),
  backgroundSlots: envNumber("OLLAMA_BACKGROUND_SLOTS"),
});

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
  plugins: [conversation],
  channels: [httpChannel],
  auth: oidcAuth,
  directory: staticDirectory,
  vectorIndex: qdrantIndex(),
  conversationStore: qdrantConversations(),
  access: { unknown: "refuse" },
  models: {
    turn: main,
    embedding: ollamaEmbedding(process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text"),
  },
  context: { profiles: { default: { conversation, layers: [], budget: { maxChars: 8000 } } } },
  i18n: { defaultLocale: "it", locales: { en, it } },
  traces: { sink: jsonlTraces(), level: "meta" },
  version: pkg.version,
});
```

Settings that change between machines, and secrets, never go here: they go in `.env`, and each piece reads its own
(see [Environment variables](../environment/)). A field whose value changes between machines, like a model's settings in
[`models`](#models), reads it from `.env` through `envNumber` or `envBoolean`.

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
empty list needs its own text. A kind with no rule isn't shown. A kind the model would only show anyway, because it is
the answer (a link the person asked for), takes `always: true` in its rule: it's shown after the answer every time,
without the model calling `present`. A rule gets the texts of the person the turn is for as
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

## `vectorIndex`

Where the long-term memory is found by meaning: the summaries of past conversations, what the agent learned about
each person, the corrections to how a tool is used, and searching past messages. See
[Memory](../../concepts/memory/).

```ts
import { qdrantIndex } from "@mercury-fw/store-qdrant";

vectorIndex: qdrantIndex(),
```

Left out, the agent keeps no long-term memory: it doesn't summarize conversations, doesn't learn corrections, and
the model isn't offered the tool that searches past messages. A plugin that needs it (`needs: ["vectorIndex"]`) stops
the agent at startup when it's left out (see [What a plugin can use](../../concepts/primitives/)). An index that can't start leaves the agent the same
way, said once in the log; an index that isn't answering yet only delays the memory until it does.

## `conversationStore`

Where every conversation is kept word for word, with its title: what a chat interface shows when it reopens a
conversation and lists them. See [Memory](../../concepts/memory/#where-its-kept).

```ts
import { qdrantConversations } from "@mercury-fw/store-qdrant";

conversationStore: qdrantConversations(),
```

Left out, nothing is archived: no conversation is reopened or listed, there are no titles, and the HTTP channel
serves no conversation routes. A plugin that needs it (`needs: ["conversationStore"]`) stops the agent at startup
when it's left out. A store that can't start leaves the agent the same way, said once in the log.

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

## `models`

The models the agent runs on, each given the job the core has for it, its role:

| Role | |
|---|---|
| `turn` | **Required.** The model that answers: every turn, the summary written when a conversation gets too long, and the checks a plugin runs on an answer. |
| `background` | The model for the work nobody is waiting on: a conversation's title, what the memory keeps of a conversation, the corrections it learns, the wiki's nightly review. Left out, it's the `turn` model. |
| `embedding` | The model that turns text into numbers for the memory found by meaning (see [`vectorIndex`](#vectorindex)). Needed with a vector index: an agent with one and no `embedding` model stops at startup and says so. Without a vector index nothing is embedded, and none is needed. |

A model is declared once, with `ollamaModel(name, settings)` for one that writes or `ollamaEmbedding(name, { capacity })` for an embedding model, and then given to its roles. The name is the model's name on the Ollama server (`OLLAMA_HOST`). The same declaration in two roles is one model; two declarations with the same name are two.

The settings of `ollamaModel` say how the model generates, for every call on it. Every field is optional: a field left out isn't sent to Ollama, so the model's own value applies, the one in its Modelfile.

| Field | |
|---|---|
| `think` | Whether the model reasons before it answers (on when left out). `false` for a model that doesn't support it: Ollama refuses its requests otherwise. |
| `temperature` | How much room the less likely words get, from 0 up. Lower is more predictable: a model that guesses commands instead of reading how to write them guesses less at a low temperature. |
| `topP` | Before each word is picked, only the most likely ones whose probabilities add up to this are kept. Above 0, at most 1. |
| `topK` | Before each word is picked, only this many of the most likely ones are kept. A whole number from 1 up. |
| `capacity` | How many requests the model's server answers at the same time: a whole number from 1 up, 1 when left out. Ollama answers one at a time unless its own `OLLAMA_NUM_PARALLEL` says otherwise, and some models only ever one at a time. `ollamaEmbedding` takes it too. |
| `backgroundSlots` | How many of those requests the work nobody is waiting on may take at once (see [Work nobody waits on](#work-nobody-waits-on)): a whole number from 1 up, 1 when left out, below `capacity` when that's above 1 and only 1 with capacity 1 (anything else stops the agent at startup). With `capacity: 8, backgroundSlots: 2`, six requests are always free for the people talking to the agent. |

An empty name, or a value out of its range, stops the agent at startup, and the log says which model and which field. At startup the log also says what each role runs on:

```
[model] turn qwen3.8:27b: think on, temperature 0.2, capacity 1
[model] background: the turn's model
[model] embedding nomic-embed-text: capacity 1
```

`server defaults` takes the place of the settings when none is set.

Each value usually comes from `.env`, so the same app can run another model somewhere else with other values. A scaffolded app declares its model above the config and gives it its roles:

```ts
import { defineMercuryConfig, envBoolean, envNumber, ollamaEmbedding, ollamaModel } from "@mercury-fw/core";

const main = ollamaModel(process.env.OLLAMA_MODEL, {
  think: envBoolean("OLLAMA_THINK", true),
  temperature: envNumber("OLLAMA_TEMPERATURE"),
  topP: envNumber("OLLAMA_TOP_P"),
  topK: envNumber("OLLAMA_TOP_K"),
  capacity: envNumber("OLLAMA_CAPACITY"),
  backgroundSlots: envNumber("OLLAMA_BACKGROUND_SLOTS"),
});

export default defineMercuryConfig({
  // ...
  models: {
    turn: main,
    embedding: ollamaEmbedding(process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text"),
  },
});
```

`envNumber(name, fallback?)` reads a number from the variable, and `envBoolean(name, fallback)` reads `true` or `false`.
An empty or missing variable gives the fallback: with none, as for the four numbers above, the field is left out and
the model's own value applies (and the capacity and the background slots are 1). Write one to have a default of your own, `envNumber("OLLAMA_TEMPERATURE", 0.2)`. Text
that isn't a number, or isn't `true` or `false`, stops the agent at startup with the variable's name. The variables are
listed in [Environment variables](../environment/#the-model).

To run the background work on a smaller model, declare it and give it the `background` role:

```ts
models: {
  turn: main,
  background: ollamaModel("<smaller-model>", { think: false }),
  embedding: ollamaEmbedding(process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text"),
},
```

A plugin that needs a model of its own takes one in its configuration, `somePlugin({ model: ollamaModel("<its-model>") })`: the agent decides which model it is, and the plugin gets it from Mercury with `ctx.modelFor` in its `build()`.

### Work nobody waits on

Besides answering, the agent uses its models for work nobody is waiting on: a conversation's title, what the memory
keeps of a conversation, the corrections it learns, the index of the archive, the wiki's nightly review. A model
answers a limited number of requests at the same time (its `capacity`); one answering one at a time, while it writes a
title, makes the person who just wrote wait.

So that work waits for its turn. Each model has a queue, and:

- an answer is never held back: from the moment a message arrives until its answer is out, it counts on the `turn`
  model;
- the work nobody waits on runs one model call at a time, and only when the answers leave a request of the model's
  `capacity` free, never more than `backgroundSlots` at once. On a model with capacity 1 it runs only while nobody
  is waiting for an answer;
- between two calls of the same work, an answer that arrived goes first;
- a title, a correction and the archive's index go before what can wait longer (what the memory keeps, the nightly
  review).

A plugin's own work of this kind (a job, see [Plugins](../../concepts/plugins/#after-a-turn-and-when-a-conversation-closes)) waits the same way.

Each model has its own queue: work on a `background` model of its own doesn't wait for the answers on the `turn` one.
When the agent stops, what's still waiting is dropped, and the trace says so. The [traces](../../concepts/traces/)
record each of these jobs (`background.job`): how long it waited, how long it took.

## `context`

What the model reads besides the conversation, by profile. See [Context](../../concepts/context/) for what a layer is.

```ts
const conversation = conversationWindow();
const teamWiki = wiki();
const rag = myRag({ ... });

plugins: [conversation, teamWiki, rag],
context: {
  profiles: {
    default: { conversation, layers: [teamWiki], budget: { maxChars: 4000 } },
    premium: { conversation, layers: [teamWiki, rag], budget: { maxChars: 12000 } },
  },
  assign: { premium: ["paid"] },
},
```

| Field | |
|---|---|
| `profiles` | The profiles by name; `default` is required. Each has `layers`, the plugins whose layers the model reads, in order, and `budget.maxChars`, how many characters of them at most (a whole number from 0 up). It may also name `conversation`, the plugin that keeps its conversations (`conversationWindow()` in an app made with `mfw create`, see [Memory](../../concepts/memory/#the-conversation)); left out, no conversation is kept, and the model reads each message alone. |
| `assign` | Which roles get which profile: `{ premium: ["paid"] }`. Someone holding roles for more than one gets the first profile listed here. Everyone else, and the terminal, gets `default`. |

A layer names the plugin itself, the same object as in `plugins`: declare the plugin once, in a constant, and use it in
both places. The agent stops at startup when a layer names a plugin that isn't in `plugins`, or one that adds nothing to
the context, when a profile lists the same plugin twice, or when a budget isn't a whole number. The same for
`conversation`: the agent stops when it names a plugin that isn't in `plugins` or keeps no conversation, and when a
plugin in `plugins` keeps conversations but no profile names it. A plugin that couldn't load loses its layer (or its
conversation), said once in the log, and the agent starts anyway. In a space several people write in, the
conversation is kept by the profile of whoever wrote first.

These are the values the agent starts from. Someone holding `mercury.context-admin` can change a profile's budget, its
layers' order and its layers' knobs while the agent runs; those changes are kept in the data folder and win over
these until the configuration no longer allows them. See
[Changing it while the agent runs](../../concepts/context/#changing-it-while-the-agent-runs).

Left out, nothing is added to what the model reads, and no conversation is kept: the model reads each message alone.

## `traces`

Where the record of what the agent does goes, event by event, and how much each event carries. See
[Traces](../../concepts/traces/).

```ts
import { jsonlTraces } from "@mercury-fw/trace-jsonl";

traces: { sink: jsonlTraces({ keepDays: 7 }), level: "meta" },
```

- `sink` is where the events go: `jsonlTraces()` writes a file per day in the agent's data folder, keeping the last
  `keepDays` days with activity (7 when left out).
- `level` is `meta` (names, outcomes, durations, sizes; the default) or `args` (also what the tools were given, the
  summary of an action waiting for confirmation, and the error messages). Anything else stops the agent at startup.

Left out, nothing is recorded. A sink that can't start (a read-only volume, say) leaves the agent without traces,
said once in the log, and the agent starts anyway.

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
