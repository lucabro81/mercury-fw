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
have. A layer that fails is skipped for that message, and the log says so.

## Once per conversation, or every message

A layer is one of two kinds, and the kind decides where its text goes:

- a **session** layer is read once, when the person starts writing in the conversation, and goes into the system
  prompt, where it stays for the rest of the conversation. It suits something that doesn't depend on the question:
  an index of the wiki, the rules of a team. In a space shared by several people, each one gets their own, built
  for them: one person's never reaches another's answers;
- a **turn** layer is read again for every message and goes right in front of it, for that answer only. It suits
  something that depends on the question: the documents that match it. The conversation keeps the message as the
  person wrote it, without the layer's text.

The reason is speed. The model doesn't read the whole text from scratch every time: what starts the same as the
previous request is already computed and reused (on Ollama, the **prompt cache**). If a text that changes at every
message sat in the system prompt, at the very start, nothing after it could be reused, and every answer would make
the model read the whole conversation again. Kept at the end, it costs only itself. In a shared space, where each
person has their own session layers, the system prompt changes when the person writing changes, and the model
reads the conversation again for that answer.

Session layers take the budget first; turn layers get what's left.

## Profiles

Not everyone has to get the same context. The context is made of **profiles**: each one a list of layers and a
budget. `default` is everyone's; `assign` gives a profile to people holding a role (`premium` to `paid`, say). Someone
holding roles for more than one profile gets the first one listed in `assign`. The terminal always gets `default`.

A profile can only narrow what a person gets, never widen it: a layer whose plugin isn't offered to someone is
skipped in their context. When a profile lists a layer that none of the roles it's given to can ever use, the
agent says so in the log at startup.

The [traces](../traces/) record, for every answer, which profile was used and what each layer added
(`context.assembled`): how many characters, how many blocks kept and left out.
