---
title: Channels
description: Where people talk to the agent, and why the core never knows which one a message came from.
sidebar:
  order: 2
---

A **channel** connects the agent to a place where people write: it receives a message, hands it to the core, and
delivers the answer back, in whatever form that place understands (a card in Google Chat, a stream of events over
HTTP). The core sees only the message and who sent it, never the channel, so the same agent answers the same way
everywhere.

Mercury has two channels today:

- [**Google Chat**](../../plugins/channel-google-chat/): the agent is a Chat app people message directly or add
  to a space.
- [**HTTP**](../../plugins/channel-http/): an interface for a chat you build yourself, a web page or another
  program, which receives the answer as it's written.

Like plugins, a channel is active when the configuration declares it:

```ts title="mercury.config.ts"
channels: [googleChatChannel, httpChannel],
```

A declared channel with no settings stays silent and says so in the log, so you can declare one before you've set
it up.

## The terminal

`mfw repl` opens a terminal on the agent. It isn't a channel: it's a console for whoever runs the agent, there's no
login (whoever can type in it already holds the container), and it sees every tool. Use it to try things while you
build, never as the way people reach the agent.

## Conversations

A **conversation** is the sequence of messages the model remembers as one thread. What counts as one depends on
the channel: on Google Chat, a direct message or a space is one stream, and a long silence starts a new
conversation; over HTTP, the person opens as many conversations as they want and comes back to any of them, as in
any chat app. [Memory](../memory/) explains what the agent keeps of each.

Two messages in the same conversation are answered one after the other, never at once; different people, and
different conversations of the same person, run in parallel.

## Who is writing

Every channel says who sent a message: Google Chat knows the account, the HTTP channel asks an **auth provider**
to check the token the caller sends. [People and roles](../people/) explains how that becomes a person, with their
own memory and permissions.
