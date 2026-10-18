---
title: What Mercury is
description: The pieces of a Mercury agent and how they fit together, before any of the details.
sidebar:
  order: 1
---

An **agent** is a program that talks with people and acts on what they ask. It uses a **language model** (the kind
of AI that reads and writes text) to understand a message and decide what to do, and **tools** to do it: a tool is
a function the model may call, such as "search the web" or "create a Jira ticket", and the model sees only its name,
a description and the input it takes.

Writing an agent from scratch means writing the conversation loop, the memory, the connection to each chat service,
the checks on what the model may do. Mercury Framework (Mercury, for short) is that part, written once: a **framework** you build your agent on.

## The pieces

```text
  people ──► channel ──► core ──► model (Ollama)
                           │
                           ├──► plugins ──► tools ──► services
                           └──► memory (history, wiki, Qdrant)
```

- **The app** is your agent: a folder, usually its own git repository, with one file that declares what the agent
  is made of (`mercury.config.ts`) and what Docker needs to run it. `mfw create` writes one.
- **The core** (`@mercury-fw/core`) is the framework itself. It reads the app's configuration, builds the agent,
  and runs every **turn**: one message in, one answer out, with whatever tool calls the model needs in between.
- **The model** runs on an Ollama server you provide. Mercury reaches it at the address in `OLLAMA_HOST`.
- **Channels** carry messages between people and the core: [Google Chat](../../plugins/channel-google-chat/), or
  an [HTTP interface](../../plugins/channel-http/) for a chat of your own. See [Channels](../channels/).
- **Plugins** give the agent its tools. The core knows no service at all: whatever the agent can do, a plugin
  brought it. See [Plugins and skills](../plugins/).
- **Memory** keeps the conversation, the notes the agent writes, and what it learned about each person. See
  [Memory](../memory/).

## Declared means active

The app's configuration is a list. A plugin or a channel in it is active, one missing from it doesn't exist, and
there's nothing else to switch on:

```ts title="mercury.config.ts"
import { defineMercuryConfig } from "@mercury-fw/core";
import { httpChannel } from "@mercury-fw/channel-http";
import { staticAuth } from "@mercury-fw/auth-static";
import { guestWifiPlugin } from "./src/plugins/guest-wifi.ts";

export default defineMercuryConfig({
  persona: { name: "Hermes" },
  plugins: [guestWifiPlugin],
  channels: [httpChannel],
  auth: staticAuth,
});
```

This agent is called Hermes, can tell people the guest Wi-Fi, and answers over HTTP to callers that
`staticAuth` recognizes. The [configuration reference](../../reference/config/) has every field.

## Failing soft

A plugin missing a setting, or a channel left unconfigured, doesn't stop the agent: the plugin is skipped and the
log says why, the channel stays silent, the rest runs. The same goes for the long-term memory: if Qdrant can't be
reached, the agent still answers, it just remembers less. The two exceptions are about safety. An HTTP channel
without a way to tell who is calling doesn't start, and a directory of people that fails to load lets nobody in:
a broken configuration closes the agent, it never opens it.

## Where it runs

An app runs in Docker, on your laptop while you build it and on a server once people use it. `mfw start` builds
and starts it, `mfw repl` opens a terminal on it, `mfw logs` shows what it's doing. Anything that must survive a
restart (the wiki, the memory, the logins of the plugins' tools) lives on Docker volumes, never inside the
container.
