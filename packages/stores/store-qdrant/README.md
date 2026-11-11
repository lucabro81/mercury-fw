# @mercury-fw/store-qdrant

[Qdrant](https://qdrant.tech) as the vector index and the conversation store of a [Mercury](https://github.com/lucabro81/mercury-fw) agent. The index is where its memory is found by meaning: the summaries of past conversations, what the agent learned about each person, the corrections to how a tool is used, and the search through past messages behind `recall_verbatim`. The store is where every conversation is kept word for word, with its title, to reopen and list it. They're what `mfw create` puts in a new app, and the package moves with the framework, at the same version as `@mercury-fw/core`.

```ts
import { qdrantConversations, qdrantIndex } from "@mercury-fw/store-qdrant";

vectorIndex: qdrantIndex(),
conversationStore: qdrantConversations(),
```

Without a `vectorIndex` the agent keeps no memory: it doesn't summarize conversations, doesn't learn corrections, and doesn't offer the model `recall_verbatim`. Without a `conversationStore` it archives nothing: no conversation to reopen or list, no titles, no `recall_verbatim`.

## Where it connects

| Variable | |
|---|---|
| `QDRANT_URL` | Where Qdrant answers (default `http://qdrant:6333`, the service the app's compose file starts). |

Each kind of memory is a space, and each space is the Qdrant collection of the same name: `episodic_memory`, `semantic_facts`, `tool_corrections`, `verbatim_archive`. An app that gave a collection another name with the variables older versions read (`QDRANT_EPISODIC_COLLECTION`, `QDRANT_SEMANTIC_FACTS_COLLECTION`, `QDRANT_TOOL_CORRECTIONS_COLLECTION`, `QDRANT_VERBATIM_COLLECTION`) keeps it. The core creates the collections it needs at startup, as long as the embedding model's vectors are; nothing needs creating by hand.

The conversation store keeps the messages in `conversation_messages` (`QDRANT_MESSAGES_COLLECTION`) and the titles in `conversation_titles` (`QDRANT_TITLES_COLLECTION`), each point with a placeholder vector: nothing searches them by meaning. An agent from before the store kept its messages in `verbatim_archive`: on start, the store copies them into `conversation_messages` (same ids, nothing embedded again) and marks the copy done only once all of them are in, so a copy that stopped halfway starts again and a finished one is never done again. `verbatim_archive` stays, the index's space the messages are searched in.

Building either doesn't reach Qdrant: if Qdrant isn't answering when the agent starts, the agent starts anyway, without memory, and the memory comes on once Qdrant answers.

## Reading the memory

`mfw memory list` and `mfw memory read <collection>` run this package's `memory-cli.ts` in the app's container: the collections with their size, and a collection's points, newest first where it can. Both only read.
