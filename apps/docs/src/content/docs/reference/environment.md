---
title: Environment variables
description: The settings the core reads from .env, and where to find each plugin's.
sidebar:
  order: 3
---

An app reads its settings from `.env`, at the root of the app, which is never committed: it holds what changes from
one machine to another and every secret. `mfw create` writes `.env.example` with every variable the chosen pieces
read; copy it to `.env` and fill it in. After changing it, `mfw start` applies the change.

These are the core's. Each plugin's are on [its page](../../plugins/).

## The model

| Variable | |
|---|---|
| `OLLAMA_HOST` | **Required.** The Ollama server. Ollama on the machine running Docker is `http://host.docker.internal:11434`. |
| `OLLAMA_MODEL` | **Required.** The chat model. It must support tool calling. |
| `OLLAMA_EMBEDDING_MODEL` | The model that turns text into numbers for the long-term memory (`nomic-embed-text` when unset). |
| `TURN_STALL_TIMEOUT_MS` | How long an answer on a streaming channel (HTTP) waits for the model's next word before it stops with an error (default `120000`, two minutes; `0` turns it off). Time spent in a tool doesn't count. |

Which models the agent runs on, and how each generates, is the config's [`models`](../config/#models) section: a
scaffolded app reads the two models' names above, and the chat model's settings below, from these variables. Left
empty, a setting is the model's own.

| Variable | |
|---|---|
| `OLLAMA_THINK` | `false` for a model that doesn't support thinking (reasoning before it answers). Empty: on. |
| `OLLAMA_TEMPERATURE` | The model's temperature, from 0 up: lower is more predictable. |
| `OLLAMA_TOP_P` | Only the most likely words whose probabilities add up to this are kept: above 0, at most 1. |
| `OLLAMA_TOP_K` | Only this many of the most likely words are kept: a whole number from 1 up. |
| `OLLAMA_CAPACITY` | How many requests the chat model's server answers at the same time: a whole number from 1 up. Empty: 1. |
| `OLLAMA_BACKGROUND_SLOTS` | How many of those the work nobody waits on may take at once: below the capacity when it's above 1. Empty: 1. |

## Memory

| Variable | |
|---|---|
| `WIKI_VAULT_PATH` | **Required.** Where the wiki lives: in a scaffolded app, the Docker volume mounted at `/app/wiki-vault`. |
| `MERCURY_DATA_PATH` | **Required.** Where the agent keeps its own state: the linked accounts, how each person wants to be called, the plugins' data, the traces. In a scaffolded app, the Docker volume mounted at `/app/data`. An agent that used to keep them in the wiki's `.mercury/` folder copies them here on its first start, and leaves the old folder where it is. |
| `QDRANT_URL` | Qdrant, the vector index and the conversation store of an app made with `mfw create` (default `http://qdrant:6333`, the service the app's compose file starts). |
| `SESSION_IDLE_TIMEOUT_MS` | How long a quiet conversation keeps its history in memory (default 30 minutes). |
| `SESSION_RESUME_MAX_CHARS` | How many characters of a reopened conversation come back to the model (default `30000`; `0` turns resuming off). More gives the model more of the past, and makes every answer slower. |

The length of the memory's vectors comes from the embedding model, found when the agent starts: older
`QDRANT_*_VECTOR_SIZE` variables aren't read anymore.

[Memory](../../concepts/memory/) explains what each of these is for.
