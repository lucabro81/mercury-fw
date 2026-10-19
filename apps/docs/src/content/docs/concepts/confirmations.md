---
title: Confirmations
description: Why an action that can't be undone always waits for the person, and how they confirm it.
sidebar:
  order: 4
---

A language model makes mistakes: it misreads a request, picks the wrong item, or acts on a sentence that only looked
like an instruction. For most actions that's a wrong answer you can correct. For some it isn't: a deleted issue
stays deleted.

So Mercury never runs an **irreversible action** because the model decided to. When the model asks for one, Mercury
**stages** it instead: it sets the action aside, generates a one-time **token** (a random code such as
`k9m2-x7q4`), and shows it to the person with a description of what will happen. The action runs only when that
exact token comes back, from that person.

## How the person confirms

- **On Google Chat**, the agent's message carries a button: clicking it sends the token, and the card then shows
  the choice taken instead of the buttons.
- **In the terminal**, the agent prints the token: paste it back, alone, as your next message.
- **Over HTTP**, the interface you built sends the token to the confirmation endpoint.

Only the token, sent by the person, runs the action: the model can't confirm on their behalf, and a keyword like
"yes" or "go ahead" confirms nothing. A token belongs to the person whose request staged it, and it
expires after five minutes.

## Which actions need it

The plugin decides. A plugin built on a command-line tool marks the commands that need confirmation in its
allowlist (`"confirm": true`), and any other plugin stages an action through the same mechanism in its code. Mercury
itself uses it too: copying one of a person's notes into the wiki everyone reads waits for their confirmation.

An action can also be offered as a choice: the web search plugin, before reading a page from a site nobody allowed
yet, asks whether to allow it only this time or always, and each choice gets its own token.
