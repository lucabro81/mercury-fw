---
title: Memory
description: What the agent remembers, where it keeps it, and what happens to a long conversation.
sidebar:
  order: 6
---

A language model remembers nothing between one answer and the next. Every time it answers, it gets the whole
conversation again as text and reads it from scratch, and that text has a size limit (the model's **context
window**). So remembering is the framework's job, and Mercury keeps three kinds of memory.

## The conversation

The **history** is the conversation as the model gets it, and it lives in the process's memory while the
conversation is active. A plugin keeps it: `@mercury-fw/conversation-window`, which an app made with `mfw create`
declares and names in its `default` [context profile](../context/):

```ts title="mercury.config.ts"
import { conversationWindow } from "@mercury-fw/conversation-window";
import { wiki } from "@mercury-fw/wiki";

const conversation = conversationWindow();
const teamWiki = wiki();

export default defineMercuryConfig({
  plugins: [conversation, teamWiki],
  context: { profiles: { default: { conversation, layers: [teamWiki], budget: { maxChars: 8000 } } } },
  // …
});
```

Without one, the agent keeps no history at all: the model reads each message alone, which suits an agent that only
answers one-off questions.

Besides what was said, it keeps the tools the model called for each answer: what each call ran and how it went, not
what came back. On later turns the model sees it looked things up, and runs the tool again when it needs the data.
The same goes for a [skill](../plugins/#skills) it read: the skill's text isn't kept, and the model is told to read it again before using
the plugin's tools.

When it grows past 60,000 characters, the window replaces its older part with a **summary** the model writes, and
the conversation goes on from the summary plus the recent messages. The person's last message is never part of it:
it's the question the model is about to answer. Every message is also kept word for word in
an **archive**, which a chat interface shows when it reopens a conversation, and which the model can search when it
needs an exact quote. With each answer the archive also keeps what the person saw while it was being written: the
model's reasoning, the tools it used, the confirmations it asked for and how the person answered them. That part is
only for the interface: the model never reads it back. Next to the archive, each conversation gets a **title**: after
the first message the person writes, the model names the conversation from that message and its answer, and the
person can rename it from a chat interface. A title the person chose is never replaced.

After 30 minutes of silence (`SESSION_IDLE_TIMEOUT_MS`), Mercury frees the history. What happens next depends on
the channel: on Google Chat the next message starts a new conversation, with a recap of the last one as background;
over HTTP the window rebuilds the conversation from the archive when the person writes again, as if no time had
passed: its newest messages word for word, and, when it was given something to read them with (`earlier`), the
summaries of what came before them.

The window takes these options:

| Option | |
|---|---|
| `maxChars` | How many characters of messages it holds before it shortens what came before (default 60000). |
| `overflow` | How it shortens: `"summarize"` (the default) has the model write a summary, which the person waits for; `"truncate"` drops the oldest messages, which costs nothing and forgets them. |
| `reopen` | `{ maxChars }`, how many characters of a reopened conversation come back when the channel sets no budget of its own (default half of `maxChars`, `0` for nothing); `false` never reads the archive, and the window then doesn't need a conversation store. |
| `earlier` | What reads the summaries of a reopened conversation's older part. Without it, only the newest messages come back. |

Reopening reads the app's conversation store, so the window needs one (`needs: ["conversationStore"]`) unless
`reopen` is `false`: an app that declares none doesn't start, and says why. A store that can't be reached while the
agent runs only means a reopened conversation starts empty; a store that couldn't start at all (a setting missing)
leaves the window out, and the log says so: the model then reads each message alone.

It also gives the model `recall_tool_calls`: what it ran earlier in the conversation and what came back, from the
log of the recent tool calls, so it quotes them instead of guessing.

## The wiki

The **wiki** is a folder of Markdown notes the agent reads and writes, kept as a git repository on a Docker volume.
It has a common area (`curated/`) everyone reads, where only people put things, and an area for each person, where
the agent writes the notes it takes for them. A note moves from a person's area to the common one only when they
confirm it, with a token like any [irreversible action](../confirmations/).

A plugin keeps it too: `@mercury-fw/wiki`, which an app made with `mfw create` declares, in `plugins` for its tools
and in the `default` profile's `layers` for its index, which the model reads at the start of each conversation (the
example above). The vault is where `WIKI_VAULT_PATH` says, unless `wiki({ vaultPath })` says otherwise.

| Option | |
|---|---|
| `vaultPath` | Where the vault lives; `WIKI_VAULT_PATH` when left out. With neither, the app doesn't start. |
| `review` | When the nightly review runs, `{ at: "HH:MM", timeZone }` (the instance's time zone when left out); every day at `"03:00"` by default, `false` for none. |

Every night the review goes through the vault on the model: it sorts what was pasted into `raw/` into the common
area, keeps the index in line with it, and looks for documents that contradict each other.

`mfw vault` reads and writes the wiki from your terminal.

## The long-term memory

After a conversation, Mercury writes short summaries of what was said, asked and decided (never the data a tool
returned, which goes stale) to a vector database, [Qdrant](https://qdrant.tech). In later conversations it finds
the summaries related to what the person is asking and gives them to the model as background, so the agent
remembers the person. Finding "related" summaries is what the **embedding model** is for: it turns text into numbers
that are close when the meaning is close.

All this work (the summaries, the title, the corrections, the archive's index) waits for the model to be free: it
never makes someone who's waiting for an answer wait longer (see [Work nobody waits on](../../reference/config/#work-nobody-waits-on)).

Where the summaries go is the app's **vector index**, `vectorIndex` in its config: Qdrant, in an app made with
`mfw create`. An app that declares none keeps no long-term memory at all (see
[the config reference](../../reference/config/#vectorindex)).

`mfw memory` lists and reads what's stored.

## Where it's kept

Two kinds of storage hold the memory, each declared in the app's config:

| | Holds | Read by | Left out |
|---|---|---|---|
| The **conversation store** (`conversationStore`) | every message word for word, and each conversation's title | person and conversation, in time order: to reopen a conversation, to list them | nothing is archived: no conversation to reopen or list, no titles |
| The **vector index** (`vectorIndex`) | the summaries, what the agent learned, the corrections, and a copy of each message to search | meaning: the entries closest to what's asked | no long-term memory, nothing learned |

The store is the record: what's in it is what was said. The index is derived from it, made to find things, and its
answers are the closest matches, not exact ones. Searching past messages (`recall_verbatim`) needs both. An app made
with `mfw create` declares Qdrant for both.

## When something is missing

Without a plugin keeping the conversation the model reads each message alone, without a vector index there's no
long-term memory at all, without a conversation store no archive; if either can't be reached, or the wiki is empty,
the agent still answers, it just remembers less.
