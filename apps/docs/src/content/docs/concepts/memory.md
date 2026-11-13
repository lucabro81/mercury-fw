---
title: Memory
description: What the agent remembers, where it keeps it, and what happens to a long conversation.
sidebar:
  order: 6
---

A language model remembers nothing between one answer and the next. Every time it answers, it gets the whole
conversation again as text and reads it from scratch, and that text has a size limit (the model's **context
window**). So remembering is the app's job: each kind of memory is a plugin the app declares, and an app made with
`mfw create` declares all of them. Leave one out and the agent does without what it does.

## The conversation

The **history** is the conversation as the model gets it, and it lives in the process's memory while the
conversation is active. A plugin keeps it: `@mercury-fw/conversation-window`, which an app made with `mfw create`
declares and names in its `default` [context profile](../context/):

```ts title="mercury.config.ts"
import { conversationWindow } from "@mercury-fw/conversation-window";
import { wiki } from "@mercury-fw/wiki";
import { archive } from "@mercury-fw/archive";
import { titles } from "@mercury-fw/titles";
import { profile } from "@mercury-fw/profile";
import { memory } from "@mercury-fw/memory";
import { corrections } from "@mercury-fw/corrections";

const teamWiki = wiki();
const longTermMemory = memory({ wiki: teamWiki });
const conversation = conversationWindow({ earlier: longTermMemory });

export default defineMercuryConfig({
  plugins: [conversation, teamWiki, longTermMemory, archive(), titles(), profile(), corrections({ wiki: teamWiki })],
  context: { profiles: { default: { conversation, layers: [teamWiki, longTermMemory], budget: { maxChars: 8000 } } } },
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
it's the question the model is about to answer.

After 30 minutes of silence (`SESSION_IDLE_TIMEOUT_MS`), Mercury frees the history. What happens next depends on
the channel: on Google Chat the next message starts a new conversation, with a recap of the last one as background (see [The long-term memory](#the-long-term-memory));
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

## The archive and the titles

Every message is also kept word for word in an **archive**, by another plugin, `@mercury-fw/archive` (`archive()`):
a chat interface shows it when it reopens a conversation, and the model can search it when it needs an exact quote.
With each answer the archive also keeps what the person saw while it was being written: the model's reasoning, the
tools it used, the confirmations it asked for and how the person answered them. That part is only for the
interface: the model never reads it back. A turn that failed leaves nothing, and neither do the turns typed in the
terminal (`mfw repl`).

Next to the archive, `@mercury-fw/titles` (`titles()`) gives each conversation a **title**: after the first message
the person writes, the model names the conversation from that message and its answer, and the person can rename it
from a chat interface. A title the person chose is never replaced.

Both write to the app's conversation store (see [Where it's kept](#where-its-kept)), so both need one
(`needs: ["conversationStore"]`): an app that declares them without a store doesn't start, and says why. An app with
a store and no plugin using it starts with a line in the log saying the store stays empty. Both write what the core
hands every plugin once a turn is over (`onTurnRecord`, see
[What a plugin can use](../primitives/)), so a plugin of your own can keep the conversation somewhere else.

## What each person said about themselves

`@mercury-fw/profile` (`profile()`) gives the model three tools to save what a person tells it about themselves: how
they want to be called (`set_preferred_name`), the time zone they're in (`set_time_zone`) and the language they want
(`set_preferred_language`, only when the app ships more than one). Mercury keeps them in its data folder, out of the
wiki, and reads them back on every turn: the name in the model's instructions, the time zone on the stamp of each
message, the language in the answers and in Mercury's own texts. A chat interface can save the time zone too.
Without the plugin nothing changes them but a chat interface's settings, and an agent speaking first to someone it
doesn't know still asks their name, without saving it.

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

`@mercury-fw/memory` (`memory()`) remembers each person across conversations. Every few messages of theirs in a
conversation, counting the answers too (`captureEvery`, 6 by default: three exchanges), and when a conversation
closes, the model writes a short summary of what was said,
asked and decided (never the data a tool returned, which goes stale), and finds the facts about the person that are
likely to stay true (their team, their role, the tools they use). Both go to the app's **vector index**, `vectorIndex`
in its config: Qdrant, in an app made with `mfw create`. Finding things there by meaning is what the **embedding
model** is for: it turns text into numbers that are close when the meaning is close. Nothing typed in the terminal is
remembered.

What the memory gives back:

- **the last conversation**, at the start of a new one: its summaries and the facts it reinforced, as background the
  model doesn't take for current. The app lists the memory among a profile's `layers` for that. A conversation a chat
  interface reopens gets none of it: a new one there is a fresh start;
- **`recall_verbatim`**, a tool the model calls to find what was said in earlier conversations and quote it. Every
  message a turn leaves is indexed for it;
- **what came before in a reopened conversation**: `conversationWindow({ earlier })` reads the summaries the memory
  wrote of it, so a conversation brought back from the archive keeps its older part too.

With a wiki (`memory({ wiki })`), a fact found often enough becomes a note in the person's area, `inferred/`, which
their wiki tools read, and the last conversation's facts come from there. Which value becomes the note is decided by
counting, never by the model: the one found most often in its last three occurrences, and only when it has more
support than the note already there.

`@mercury-fw/corrections` (`corrections({ wiki })`) learns how to use a tool: when a command fails and a later one
for the same tool works in the same turn, the model describes the rule, and the wiki writes the one with most support
to `curated/standards/<tool>-<topic>.md`, which everyone reads.

All this work (the summaries, the facts, the corrections, the title, the index of the messages) waits for the model to
be free: it never makes someone who's waiting for an answer wait longer (see
[Work nobody waits on](../../reference/config/#work-nobody-waits-on)). Both plugins need the vector index and the
embedding model (`needs: ["vectorIndex", "embedding"]`): an app declaring them without one doesn't start.

| `memory()` option | |
|---|---|
| `wiki` | The wiki the facts are promoted to and read back from; without one they stay in the index. |
| `captureEvery` | How many new messages of a person in a conversation, theirs and the answers, make a summary; `SESSION_CAPTURE_MESSAGE_THRESHOLD`, else 6, when left out. |

`mfw memory` lists and reads what's stored.

## Where it's kept

Two kinds of storage hold the memory, each declared in the app's config:

| | Holds | Read by | Left out |
|---|---|---|---|
| The **conversation store** (`conversationStore`) | every message word for word (written by `archive()`), and each conversation's title (by `titles()`, or the person) | person and conversation, in time order: to reopen a conversation, to list them | nothing is archived: no conversation to reopen or list, no titles |
| The **vector index** (`vectorIndex`) | the summaries and facts (written by `memory()`), the corrections (by `corrections()`), and a copy of each message to search (by `memory()`) | meaning: the entries closest to what's asked | no long-term memory, nothing learned |

The store is the record: what's in it is what was said. The index holds what the memory found in it, made to find
things, and its answers are the closest matches, not exact ones: `memory()` indexes every message a turn leaves, the
same ones `archive()` writes. An app made with `mfw create` declares Qdrant for both.

## When something is missing

Without a plugin keeping the conversation the model reads each message alone, without `memory()` or a vector index
there's no long-term memory at all, without a conversation store or `archive()` no archive; if either can't be reached, or the wiki is empty,
the agent still answers, it just remembers less.
