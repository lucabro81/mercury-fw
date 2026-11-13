---
title: Context
description: What the model reads besides the conversation, who decides it, and why some of it is read once per conversation.
sidebar:
  order: 7
---

Every time the model answers, it reads a text made of two parts: its instructions (the **system prompt**: who it
is, what its plugins do) and the conversation so far. Anything else it should know (a page of the company wiki, the
documents that match the question) has to be added to that text. That addition is the **context**, and the app
decides what goes in it, in `mercury.config.ts` (see [`context`](../../reference/config/#context)). An app that
declares no context adds nothing.

## Layers

What gets added comes from plugins. A plugin that has something for the model to read contributes a **layer**: a
piece of code that, when asked, returns a few blocks of text, the most important first. The app lists the plugins
whose layers it wants, in order, and gives the whole context a **budget**: how many characters at most. Mercury
keeps whole blocks, layer by layer, while they fit; a block that doesn't fit is left out, never cut in half.

A plugin's layer only runs for people the plugin is offered to: the same [roles](../people/) that decide who may use
its tools decide whose context it can add to, and it reads what it reads with the same identity its tools would
have. A layer that fails is skipped, and the log says so: a turn layer for that message, a session layer until
the conversation closes.

## Once per conversation, or every message

A layer is one of two kinds, and the kind decides where its text goes:

- a **session** layer is read once, when the person starts writing in the conversation, and goes into the system
  prompt, where it stays for the rest of the conversation. It suits something that doesn't depend on the question:
  an index of the wiki, the rules of a team. In a space shared by several people, each one gets their own, built
  for them: one person's never reaches another's answers. A session layer that fails stays out until the
  conversation closes, so the system prompt doesn't change halfway;
- a **turn** layer is read again for every message and goes right in front of it. It suits something that depends
  on the question: the documents that match it. The model reads it there on the later messages too; what the
  conversation keeps (what the person sees, the archive, the memory) is the message as the person wrote it, without
  the layer's text.

The reason is speed. The model doesn't read the whole text from scratch every time: what starts the same as the
previous request is already computed and reused (on Ollama, the **prompt cache**). If a text that changes at every
message sat in the system prompt, at the very start, nothing after it could be reused, and every answer would make
the model read the whole conversation again. Kept at the end, it costs only itself, and it stays where it was:
taking it out at the next message would change the middle of the text, and some models (the ones whose cache can
only grow) would read the whole conversation again from there. The price is room: the texts of the turn layers stay
in what the model reads, and count toward the size at which a long conversation gets summarized. In a shared space, where each
person has their own session layers, the system prompt changes when the person writing changes, and the model
reads the conversation again for that answer.

Session layers take the budget first; turn layers get what's left.

## Profiles

Not everyone has to get the same context. The context is made of **profiles**: each one a list of layers and a
budget. `default` is everyone's; `assign` gives a profile to people holding a role (`premium` to `paid`, say).
Someone holding roles for more than one profile gets the first one listed in `assign`. The terminal always gets
`default`. A person keeps the profile they had when they started writing in a conversation until it closes, even if
their roles change meanwhile.

A profile can only narrow what a person gets, never widen it: a layer whose plugin isn't offered to someone is
skipped in their context. When a profile lists a layer that none of the roles it's given to can ever use, the
agent says so in the log at startup.

A profile can also name the plugin that keeps its conversations (`conversation`, see
[What a plugin can use](../primitives/#keeping-the-conversation)): how much of the conversation the model reads,
and what happens when it grows too long. A profile that names none keeps no conversation: the model reads each
message alone. A conversation is kept by the profile of whoever started it, for as long as it stays open. A layer learns whether the conversation is one its chat interface reopened (`reopened`), rather
than one just started: a layer recalling the person's last conversation leaves it out then.

## Changing it while the agent runs

A profile's budget, the order of its layers and the layers' **knobs** can change without restarting the agent. A knob
is a setting a plugin offers for its layer: how many documents to fetch, say, or which kind first. The plugin says
what each knob is (a yes/no, a number between two limits, one of a list of words), what it does, and its default; a
profile that doesn't set it gets the default.

Changing them is for people holding the role `mercury.context-admin`, which the [directory](../people/) gives like
any other role, through an admin area that calls the [HTTP channel](../../plugins/channel-http/) (`GET /context`,
`PATCH /context/profiles/{name}`). The agent checks a change whole before applying it: the same layers in another
order, never one more or one less, a whole number for the budget, a value each knob allows. A change applies from
the next message; a conversation already open keeps its **session** layers as they were built, so its system prompt
doesn't change halfway, and gets the new ones when it closes.

The changes are kept in the agent's data folder (`context-settings.json`), so they survive a restart. At startup each
one is checked again against the configuration and the plugins as they are then: one that no longer fits (a layer
removed from the profile, a knob a newer version of its plugin dropped) is ignored, the log says so, and the
configuration's value holds. Every change is also recorded, with who made it, when, and what it changed before and
after (`context-changes.jsonl`, read with `GET /context/changes`).

## What the traces show

The [traces](../traces/) record, for every answer, which profile was used and what each layer added
(`context.assembled`): how many characters, how many blocks kept and left out. Each change to a profile is a
`context.changed`.
