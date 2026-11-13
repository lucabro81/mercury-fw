# @mercury-fw/memory

The long-term memory of a [Mercury](https://github.com/lucabro81/mercury-fw) agent: what it remembers of its conversations with each person, in the app's vector index. It's the plugin `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Memory](https://lucabro81.github.io/mercury-fw/concepts/memory/#the-long-term-memory).

```ts
import { memory } from "@mercury-fw/memory";
import { wiki } from "@mercury-fw/wiki";
import { conversationWindow } from "@mercury-fw/conversation-window";

const teamWiki = wiki();
const longTermMemory = memory({ wiki: teamWiki });
const conversation = conversationWindow({ earlier: longTermMemory });

export default defineMercuryConfig({
  plugins: [conversation, teamWiki, longTermMemory],
  context: { profiles: { default: { conversation, layers: [teamWiki, longTermMemory], budget: { maxChars: 8000 } } } },
  vectorIndex: qdrantIndex(),
  models: { turn: main, embedding: ollamaEmbedding("nomic-embed-text") },
  // …
});
```

It needs the vector index and the embedding model (`needs: ["vectorIndex", "embedding"]`): an app declaring it without them doesn't start, and says why.

| Option | |
|---|---|
| `wiki` | The wiki the facts are promoted to and read back from (`wiki()`, declared in `plugins` too). Without one, the facts stay in the index. |
| `captureEvery` | How many new messages of a person in a conversation, theirs and the answers, make a summary. `SESSION_CAPTURE_MESSAGE_THRESHOLD` when left out, else 6. |

## What it keeps

After each turn a person wrote (`afterTurn`), their message, stamped with when and where they wrote it, and the answer wait in a buffer for that conversation and that person. Once there are `captureEvery` of them, and when the conversation closes for being quiet (`onSessionClose`), the background model:

- writes a short summary of what was said, asked and decided, never the data a tool returned (`episodic_memory`);
- finds the facts about the person likely to stay true, among `team`, `role` and `tools-used` (`semantic_facts`), and with a wiki promotes each through its `notes` to the person's `inferred/` note.

A capture is work nobody waits on (`memory:capture` in the traces). One that fails keeps its messages for the next one, with a line in the log; when the conversation closes, a capture already running finishes first, then what came after it is captured once and, if that fails, dropped, with a line in the log; a fact that can't be kept never undoes the summary. Every message a turn leaves (`onTurnRecord`, the same ones the archive writes) is indexed too (`verbatim_archive`, `memory:archive-index`). Nothing of the operator's (the terminal) is kept.

The spaces are made at their first use, as long as the embedding model's vectors; an index from an older Mercury, whose points carry a bare channel id instead of the person's key, gets them moved onto it then (a Google Chat id and the terminal; any other id stays where it is, with a line in the log).

## What it gives back

- A `session` context layer, when a profile lists the plugin among its `layers`: at the start of a conversation, the last one's summaries and, with a wiki, the facts they reinforced, as background the model doesn't take for current. Nothing for a conversation its client reopened (`reopened`), where a new one is a fresh start, or for the operator.
- `recall_verbatim`, a tool for the person the turn is for: their messages from earlier conversations closest in meaning to what the model asks, as they were said (no lists shown, no calls). The system prompt says when to use it.
- `summariesOf({ person, sessionKey })`, one conversation's summaries oldest first: what `conversationWindow({ earlier })` brings back of a reopened conversation's older part.

`mfw memory` lists and reads the spaces (it reads Qdrant, through `@mercury-fw/store-qdrant`).
