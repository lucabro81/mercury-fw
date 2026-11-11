# @mercury-fw/store-qdrant

[Qdrant](https://qdrant.tech) as the vector index of a [Mercury](https://github.com/lucabro81/mercury-fw) agent: where its memory is found by meaning. It holds the summaries of past conversations, what the agent learned about each person, the corrections to how a tool is used, and the search through past messages behind `recall_verbatim`. It's the index `mfw create` puts in a new app, and it moves with the framework, at the same version as `@mercury-fw/core`.

```ts
import { qdrantIndex } from "@mercury-fw/store-qdrant";

vectorIndex: qdrantIndex(),
```

Without a `vectorIndex` the agent keeps no memory: it doesn't summarize conversations, doesn't learn corrections, and doesn't offer the model `recall_verbatim`.

## Where it connects

| Variable | |
|---|---|
| `QDRANT_URL` | Where Qdrant answers (default `http://qdrant:6333`, the service the app's compose file starts). |

Each kind of memory is a space, and each space is the Qdrant collection of the same name: `episodic_memory`, `semantic_facts`, `tool_corrections`, `verbatim_archive`. An app that gave a collection another name with the variables older versions read (`QDRANT_EPISODIC_COLLECTION`, `QDRANT_SEMANTIC_FACTS_COLLECTION`, `QDRANT_TOOL_CORRECTIONS_COLLECTION`, `QDRANT_VERBATIM_COLLECTION`) keeps it. The core creates the collections it needs at startup, as long as the embedding model's vectors are; nothing needs creating by hand.

Building it doesn't reach Qdrant: if Qdrant isn't answering when the agent starts, the agent starts anyway, without memory, and the memory comes on once Qdrant answers.

## Reading the memory

`mfw memory list` and `mfw memory read <collection>` run this package's `memory-cli.ts` in the app's container: the collections with their size, and a collection's points, newest first where it can. Both only read.
