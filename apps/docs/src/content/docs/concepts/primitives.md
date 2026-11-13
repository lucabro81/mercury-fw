---
title: What a plugin can use
description: The pieces of the agent a plugin is handed when it starts, how it asks for them, and what each one promises.
sidebar:
  order: 3.5
---

A plugin is code the app hands to Mercury, and Mercury runs its `build` once, at startup. What `build` receives is
the plugin's whole view of the agent: everything a plugin can use is in that object (`ctx`), and nothing else is
reachable. These pieces are the **primitives**, and each one has a type in the plugin contract
(`@mercury-fw/kit` exports them all), documented in the [contract's reference](../../reference/api/types/plugin-types/).

Some primitives every plugin gets. Others only exist when the app declares them in `mercury.config.ts` (a vector
index, say), so a plugin that uses one asks for it by name in `needs`:

```ts
export const notesPlugin: Plugin = {
  apiVersion: PLUGIN_API_VERSION,
  name: "notes",
  description: "Remembers what each person asked to note down.",
  needs: ["vectorIndex", "embedding"],
  build: async (ctx) => {
    // ctx.vectorIndex and ctx.embed are there: the plugin asked for them.
    …
  },
};
```

An app that declares the plugin without declaring what it needs doesn't start, and the error names the plugin and
the missing piece: that's a mistake in the configuration, found before anyone writes to the agent. A piece the app
declares but that couldn't start (an index whose settings are missing) is a different case: the plugin is left out,
the log says why, and the agent starts without it.

## What every plugin gets

| In `ctx` | What it is |
|---|---|
| `env`, `log` | The environment, for the plugin's own settings, and a line in the agent's log. |
| `assistantName` | The assistant's name, for a text the plugin builds while it runs. |
| `dataDir` | A folder of the plugin's own, on the agent's data volume, kept across restarts. |
| `model` | The model the turns run on. A call from inside a turn is part of that turn. |
| `backgroundModel` | The model for work nobody waits on: the app's `background` model, or its `turn` model when it declares none. |
| `job` | Runs work nobody waits on, when the model is free (below). |
| `daily` | Runs work every day at a set time (below). |
| `profiles` | What each person told the agent about themselves: their name, their language, their time zone. |
| `toolLog` | The tool calls of the recent turns, per person: kept in memory, gone after a restart. |

`job` and `daily` deserve a word each.

**`job(name, urgency, fn)`** runs `fn` through the agent's queue for the models: every model call inside it waits
until the people talking to the agent leave the model a free slot. Use it for anything that calls a model after the
person already has their answer (a summary, a title). `"soon"` work goes before `"idle"` work, and the
[traces](../traces/) show each job as `<plugin>:<name>`.

**`daily(name, { at, timeZone }, fn)`** runs `fn` every day at `at` (`"03:00"`), in `timeZone` or in the app's
(`i18n.timeZone`). Only the running service runs it (never the dev REPL), and a day the agent wasn't up at that minute
has no run, never one made up later. A night whose clocks go back still has one run. `fn` isn't held for the model:
work that calls one goes in a `job` inside it. An `at` that isn't a time of day, or a time zone that doesn't exist,
stops the agent at startup.

## What a plugin asks for

| `needs` | In `ctx` | What it is |
|---|---|---|
| `"vectorIndex"` | `vectorIndex` | The app's [vector index](../../reference/config/#vectorindex): spaces of points, found by meaning. |
| `"embedding"` | `embed` | Turns a text into its vector, with the app's embedding model. |
| `"conversationStore"` | `conversations` | The app's [conversation store](../../reference/config/#conversationstore): every message of every conversation, word for word. |

The **vector index** is shared by the whole agent and knows nothing about people. A plugin creates its own spaces
(`ensure` is safe to call every time), names them after itself, and filters every read of a space holding people's
data on the person's key, as Mercury does with its own.

The **conversation store** is shared too, and the channels read it: it's what a chat interface shows when someone
reopens a conversation. So what is kept there has one shape, `StoredMessage`: who spoke, the text, the tool calls an
answer was written from, the lists the person saw, what they saw of the turn besides the text. A plugin writing
there writes that shape, and may leave out the optional parts; a new part is a change of the contract, never a field
one plugin adds on its own.

Both can be away for a while (the service behind them restarting): every call may reject, and a plugin treats that
as the service being away for now, never as a reason to fail the person's turn.

## Keeping the conversation

One more thing a plugin can contribute is how the conversation is kept: what the model reads of it on every
message, and what happens when it grows too long. A plugin that does it contributes a `conversation`, and the app
names it in a [context profile](../../reference/config/#context): Mercury opens one conversation per session with
it, at the session's first message, and hands it every message the turn adds. When the session closes Mercury tells
the plugin, so it can let go of what it kept.

## A plugin that learns from what was said

The pieces fit together. This plugin keeps a line for every turn in which a person asked to note something, and
gives it back to the model at the start of their next conversation:

```ts
export const notesPlugin: Plugin = {
  apiVersion: PLUGIN_API_VERSION,
  name: "notes",
  description: "Remembers what each person asked to note down.",
  // It reaches no outside service: no one's identity, offered to everyone.
  actsAs: "anyone",
  needs: ["vectorIndex", "embedding"],
  build: (ctx) => ({
    afterTurn: async (turn) => {
      if (!/^note:/i.test(turn.input)) return;
      // Mercury doesn't wait for this, and logs it if it fails.
      await ctx.job!("store", "soon", async () => {
        const vector = await ctx.embed!(turn.input);
        // The space's vectors are as long as the app's embedding model makes them.
        await ctx.vectorIndex!.ensure("notes", { dimensions: vector.length, keys: ["person"] });
        await ctx.vectorIndex!.upsert("notes", [{ id: crypto.randomUUID(), vector, payload: { person: turn.person.key, text: turn.input } }]);
      });
    },
    context: {
      scope: "session",
      build: async (req) => {
        // No note written yet means no space yet: nothing to add.
        const found = await ctx.vectorIndex!.scroll("notes", { where: { person: req.person.key }, limit: 20 }).catch(() => undefined);
        return found?.points.map((p) => String(p.payload.text));
      },
    },
  }),
};
```

`afterTurn` runs once the person has their answer, and nothing waits for it (see
[Plugins and skills](../plugins/#after-a-turn-and-when-a-conversation-closes)); the `context` layer is read once per
conversation, at its first message (see [Context](../context/)). The app declares the index and the embedding model,
puts the plugin in `plugins`, and lists it in a profile's `layers`.
