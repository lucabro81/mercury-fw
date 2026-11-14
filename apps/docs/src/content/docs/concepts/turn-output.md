---
title: What a turn returns
description: The model's text, the lists it shows, the checks on its answer, and the answers that aren't text at all.
sidebar:
  order: 3.7
---

A **turn** is one message in and one answer out: the person writes, the model reads what it's given, calls the
tools it needs, and answers. By default the answer is the model's text. Three things change what comes out, though,
and they're easy to mix up: **displays**, **guards** and the agent's **output**. Each one runs at a different
moment, for a different reason.

| What | Who writes it | When | What it does |
|---|---|---|---|
| The model's text | the model | while the turn runs, streamed to channels that show it live | it's the answer |
| A display | a tool, in its result | when the tool returns | a list or a link shown to the person, never copied by the model |
| A guard | a plugin | after the model is done, before the person sees the answer | checks the finished text and may rewrite it |
| The output | the agent's configuration | for every turn | decides whether the answer is text at all |

## The model's text

Without anything else configured, the answer is what the model writes. A channel that shows text as it arrives (the
HTTP channel, the terminal) gets it piece by piece; the others get it once it's finished. The conversation keeps it,
so the next turn reads it too.

## Displays: what a tool shows the person

Some results are for the person, not for the model: thirty Jira issues, the link that opens a search. Copying them
into its answer is slow, and a small model gets it wrong (it drops an item, or retypes a long encoded URL and breaks
it). So a tool can return a **display** next to what the model reads:

```ts
execute: async ({ query }) => ({ ok: true, query, display: { type: "search-link", items: [{ url, query }] } }),
```

Here's what happens to it:

1. The tool returns its result, `display` included.
2. Mercury takes `display` out before the model sees the result: the model reads `ok`, `query` and a `displayRef`, a
   reference to the list, never the list itself.
3. The model decides whether the person sees it, by calling `present` with that reference. Answering "how many are
   open?" doesn't need the list; "show me the open ones" does.
4. When the turn ends, Mercury writes the list it was asked to present after the model's text, each item as the
   app's formatter rule says (`@mercury-fw/formatter`, see [Lists for the person](../plugins/#lists-for-the-person)).
   A rule with `always: true` shows that kind every time, with no `present` needed: the model is told it's already
   there.

So the person sees the model's sentence and, after it, the list as the app formats it. The model wrote neither the
items nor the links.

## Guards: a check on the finished answer

A **guard** (`PostTurnGuard`) is a piece of a plugin that runs over the model's finished text, after the last model
step and before the person gets it. It sees the text and the turn's tool calls, and returns the text, changed or
not. Guards run in the order their plugins are declared; one that fails leaves the text as it was, and the answer
goes out anyway.

The web search plugin has one, the sources guard: after a turn that read pages with `web_fetch`, it ends the answer
with "Sources" and the title and address of each page read, built from the tool results. The model never writes that
list, so it can't leave a page out or invent one; a list of sources the model wrote anyway is dropped.

A plugin contributes one by returning `postTurnGuards` from its `build()`. While it runs, the person sees a status
line, as for a tool call.

## When the answer isn't text

Some agents don't talk. An agent behind a search form, for instance, has one job: turn a request into a query, and
hand the query to a program (a **controller**) that runs it. A sentence around the query is something the controller
has to dig it out of; asking the model in its instructions to "only write the query" works until a small model adds
a word. So the agent's configuration can say what a turn returns, in `output`:

```ts title="mercury.config.ts"
import { defineMercuryConfig, toolOf } from "@mercury-fw/core";
import { catalogQuery, validateQuery } from "catalog-query";

const catalog = catalogQuery();

export default defineMercuryConfig({
  plugins: [catalog],
  output: { tool: toolOf(catalog, "catalog_query_build"), validate: validateQuery },
  // …
});
```

There are three modes:

| `output` | The turn returns | It ends when |
|---|---|---|
| `"text"`, or left out | the model's text | the model is done |
| `{ tool: toolOf(plugin, name) }` | that tool's whole result, `display` included | the tool returns a result that's accepted, with no further model step |
| `{ schema }` | an object matching the schema (a Zod schema, say) | the model writes JSON that matches |

The tool is named by its plugin object and its name, since a plugin can have several. The same plugin can be the
answer in one agent and a tool among others in another: whether a tool ends the turn is the agent's choice, not the
plugin's.

### What the model is told, and how many times

An output can fail to come. The model writes text instead of calling the tool, writes JSON that doesn't match the
schema, or gives a value that's well formed but wrong (a query with a field that doesn't exist). When that happens,
Mercury tells the model the exact error and lets it try again:

- a tool result that says it failed (`ok: false`) reaches the model as it is: the tool's own error is the most
  precise one there is. A tool that throws counts the same way, the model reading its error;
- `validate`, when there is one, checks every value further: a function the plugin exports, which knows things the
  schema can't say (the grammar of a query language, the fields of a catalog). Its error is what the model reads;
- text instead of the tool call, or JSON that doesn't parse, gets a sentence saying what was expected.

A value JSON can't write (one that refers to itself, say) is refused too, and ends the turn at once: the tool would
return it again.

`retries` (2 when left out) is how many times the model tries again. Every attempt is another model step, so it
costs time, and the failed ones aren't kept in the conversation: the next turn reads the person's message and the
value that came, with the tool calls that led to it (a call to the output tool that was refused isn't one of
them).

When the retries are spent, the turn fails with a `TurnOutputError`. Text never stands in for the value: a controller
that gets something that looks like an answer, and isn't, is worse off than one told why there's none.

| `code` | Why |
|---|---|
| `output-missing` | the model never gave one: it wrote text instead of calling the tool, or JSON that doesn't parse or doesn't match the schema |
| `output-invalid` | it gave one, and the tool (by failing or throwing) or `validate` refused it, or JSON can't write it |
| `output-tool-unavailable` | the tool isn't offered on this turn (the person's roles don't include its plugin, or it didn't build) |

The error also says how many attempts there were (`attempts`) and the last error the model was told (`lastError`).

### A schema, with and without tools

With a schema, Ollama binds the generation to it: the model can only write JSON of that shape, and most of the
schema's limits hold (allowed values, number ranges, how many items, how long a string), all except `pattern`. What
the generation doesn't hold, the check against the schema does, and the model tries again.

A model bound to a schema can't call tools, though. So:

- with no plugin tools on the turn (a model trained for the job, alone), the turn is a single call bound to the
  schema;
- with plugin tools, the model first works as usual, calling what it needs, and then writes its answer in one more
  call bound to the schema, with what the tools returned in front of it.

While the model calls its tools, a model that reasons (`think`) streams its reasoning as usual; the call bound to the
schema sends nothing until the value is there. A model with no tools sends nothing at all before it, which is what a
controller waits for anyway.

### What changes in the turn

| | `text` | `tool` and `schema` |
|---|---|---|
| The model's text, live | streamed to the channel | not streamed: it isn't the answer |
| Guards | run | don't run: there's no text to rewrite |
| Displays | written after the text | none added: a tool's displays are in its result, a schema has none |
| `present`, and the lists already shown | offered to the model | not offered: there's nothing to show the person |
| A turn where the agent speaks first | it introduces itself to someone it doesn't know | says nothing |
| An action waiting for confirmation, a login | the turn ends there, with its note | the same: the note, no output; the turn resumed after the confirmation returns the output |
| What the conversation keeps | the text | the value as indented JSON, with the tool calls |

### Channels

Not every channel can take every output: Google Chat shows messages to people, and has nothing to do with an object.
So each channel says which outputs it takes, besides text. The HTTP channel takes all three: its `final` event
carries `output` (`{ mode, value }`) next to the value as indented JSON in `text`, and a `TurnOutputError` arrives as
an `error` event with its `code`, `attempts` and `lastError` (see the
[HTTP API](../../reference/http-api/)). Google Chat takes text only.

An agent whose `output` one of its channels doesn't take doesn't start, and says which channel and which output.
The type check catches it first: a channel's type says what it takes (`ChannelPlugin<"tool" | "schema">`; a plain
`ChannelPlugin` takes text only), so `tsc` marks the `output` of a `mercury.config.ts` one of its channels doesn't
take. The terminal (`mfw repl`) takes them all and prints the value as JSON.

An e2e test checks an output on the HTTP channel with `expect.output` and `expect.outputError` (see
[the CLI's `mfw e2e`](https://github.com/lucabro81/mercury-fw/tree/main/apps/cli#mfw-e2e-tests---repeat-n)).
