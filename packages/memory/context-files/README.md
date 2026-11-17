# @mercury-fw/context-files

A context strategy for a [Mercury](https://github.com/lucabro81/mercury-fw) agent that keeps part of each conversation in files instead of in front of the model, which reads them in pieces with its own tools: long tool outputs, the older messages once the conversation grows past its size, and the session layers if you ask for it. It takes the place of `conversationWindow()` in a context profile, so you can compare the two on the same agent by changing one line, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#the-conversation).

## Contents

- [Using it](#using-it)
- [Options](#options)
- [What the model gets](#what-the-model-gets)
- [Where the files live](#where-the-files-live)

## Using it

```ts
import { contextFiles } from "@mercury-fw/context-files";

const conversation = contextFiles({ outputs: { overChars: 4000 }, keepRecent: 2, maxChars: 8000 });

export default defineMercuryConfig({
  plugins: [conversation],
  context: { profiles: { default: { conversation, layers: [], budget: { maxChars: 8000 } } } },
  // …
});
```

A context profile names it as its `conversation`, the same object as in `plugins`, exactly as it would name `conversationWindow()`. Nothing else in the app changes: the window, the reopening of a conversation from the archive and `recall_tool_calls` are `@mercury-fw/conversation-window`'s.

## Options

| Option | |
|---|---|
| `maxChars` | How many characters of messages the window holds before it shortens what came before, 60000 when left out. |
| `overflow` | How it shortens: `"files"` (the default) moves the older messages to a history file, `"summarize"` and `"truncate"` work as in `conversationWindow()`. |
| `keepRecent` | How many exchanges (a person's message and the answers after it, the current one included) always stay in the window with `overflow: "files"`, 4 when left out. |
| `outputs` | `{ overChars }`: a tool output longer than this (4000 characters when left out) goes to a file. `false` leaves every output whole. |
| `layers` | `true` moves the session layers (the wiki's index, what the memory recalls) to files, the system prompt keeping one line for each. Off when left out; with a profile listing no layer it does nothing. |
| `index` | `{ maxEntries }`: how many files the list in front of each message names one by one, 30 when left out; the oldest are folded into one line pointing at the search. |
| `reopen`, `earlier` | As in `conversationWindow()`. With `reopen: false` the plugin doesn't need the app's conversation store. |

Sizes are whole numbers above 0 (`reopen.maxChars` from 0 up), and `overflow` one of the three values: anything else stops the app at startup.

## What the model gets

A tool output that goes to a file reaches the model as `{ file, lines, chars, head, note }`, where `head` is its first 20 lines (1000 characters at most) and `note` tells it to read the rest before answering on it; the fields Mercury reads itself (`ok`, `error`, `displayRef`) stay on it, and a staged confirmation or a login request never goes to a file. In later turns the same call points at its file instead of saying its data is gone. What Mercury records doesn't change: the archive, the tool log, the traces and the plugins' hooks get the real output.

In front of each message the model reads the list of the conversation's files (`<context-files>`), one line each with what it holds (the tool and its input, which messages, which layer) and how many lines it has. It reads them with two tools, on the files of the turn's own conversation only:

- `read_context_file({ ref, from?, to? })`: the file's lines, numbered, 200 at most per call, with `next` when there's more;
- `search_context_files({ text, ref? })`: the lines holding a text, case-insensitive and taken as it is (not as a pattern), as `ref:line: text`, 50 at most.

A short paragraph of the system prompt always says that part of the conversation is in files and must be opened, never guessed; the `context-files` skill, read on demand like any other, says how to read them well. The tools' status lines are under the `context-files.status.read` and `context-files.status.search` keys, and `recall_tool_calls`'s under `context-files.status.recall`.

## Where the files live

In the plugin's data folder (`<data folder>/plugins/context-files/sessions/`), one folder per conversation, named by a hash of its key: everyone in a shared space reads the files of the conversation they're in, and nobody reaches another conversation's, since a ref (`outputs/3`, `history/1`, `layers/2`) is always relative to the turn's own conversation and anything not of that shape is refused. Each file is written atomically. A conversation's folder survives a restart and is removed when the conversation closes for being quiet.
