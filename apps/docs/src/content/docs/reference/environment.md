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
| `OLLAMA_EMBEDDING_MODEL` | The model that turns text into numbers for the long-term memory (default `nomic-embed-text`). |
| `OLLAMA_THINK` | `false` for a model that doesn't support thinking (reasoning before it answers). |
| `TURN_STALL_TIMEOUT_MS` | How long an answer on a streaming channel (HTTP) waits for the model's next word before it stops with an error (default `120000`, two minutes; `0` turns it off). Time spent in a tool doesn't count. |

## Memory

| Variable | |
|---|---|
| `WIKI_VAULT_PATH` | **Required.** Where the wiki lives: in a scaffolded app, the Docker volume mounted at `/app/wiki-vault`. |
| `QDRANT_URL` | Qdrant, for the long-term memory (default `http://qdrant:6333`, the service the app's compose file starts). |
| `SESSION_IDLE_TIMEOUT_MS` | How long a quiet conversation keeps its history in memory (default 30 minutes). |
| `SESSION_RESUME_MAX_CHARS` | How many characters of a reopened conversation come back to the model (default `30000`; `0` turns resuming off). More gives the model more of the past, and makes every answer slower. |

[Memory](../../concepts/memory/) explains what each of these is for.
