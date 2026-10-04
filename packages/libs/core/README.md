# @mercury-fw/core

The runtime of [Mercury](https://github.com/lucabro81/mercury-fw): it builds an agent from the config an app gives it and runs it, from the conversation loop to the channels. An app depends on it; a plugin doesn't (plugins build on [`@mercury-fw/kit`](https://www.npmjs.com/package/@mercury-fw/kit)).

The usual way to get it is scaffolding an app, which wires it up for you:

```bash
bun create mercury-agent my-agent
```

## What it exports

- `defineMercuryConfig(config)` types the app's `mercury.config.ts`: `plugins`, `channels`, `auth` (the provider that tells a channel like HTTP who is calling; HTTP doesn't start without one), `persona`.
- `composeMercury(config)` builds the agent from that config and the environment, and returns what the entrypoints start: `handleTurn`, the declared channels with their runtime, and the background jobs (`startCrons`).
- `loadChannels(channels, { runtime })` turns the declared channels into started providers, and `createTerminalProvider(...)` opens the dev REPL on `handleTurn`.
- `DEFAULT_PERSONA_IDENTITY`, `DEFAULT_PERSONA_TONE` are the persona an app gets when its config sets none.

A scaffolded app's `src/index.ts` (the service) and `src/repl.ts` (the REPL) are the reference for using them.

## Environment

| Variable | |
|---|---|
| `OLLAMA_HOST` | The Ollama-compatible endpoint. Required. |
| `OLLAMA_MODEL` | The chat model. Required. |
| `OLLAMA_EMBEDDING_MODEL` | The embedding model for the episodic memory (default `nomic-embed-text`). |
| `OLLAMA_THINK` | `false` for a model that doesn't support thinking. |
| `QDRANT_URL` | Qdrant, for the episodic memory (default `http://qdrant:6333`). |
| `WIKI_VAULT_PATH` | Where the wiki lives. Required. |

Qdrant being unreachable degrades memory, it doesn't stop the agent.

## Who sees what

The core keeps one identity per person, `<provider>:<id>` (`google-chat:users/42`, `oidc:<sub>`), so two providers issuing the same id are still two people. Memory, the conversation archive, the tool log and pending confirmations are kept per person, and a confirmation can only be confirmed by whoever staged it.

The wiki has a common area, `curated/`, that everyone reads, and an area per person under `users/<key>/`, which the model sees as `personal/`: `personal/notes/` is what it writes for that person, `personal/inferred/` what consolidation learned about them. Nobody sees anyone else's area. The model can't write the common area directly: `promote_note` copies one of the person's notes there, and only once they confirm it with the token. The operator's tools (`mfw vault`, the nightly review) still see the whole vault.

An instance that ran an earlier version gets its data moved at startup: Google Chat and terminal notes into their areas, the memory's ids onto the new keys. An id that doesn't say which provider it came from stays where it is, with a line in the log.

## Several people at once

Different people, and different conversations of one person, run in parallel. Turns of one conversation run one after the other: a second message sent while the first is still being answered (two tabs on one chat, a double submit) waits for it, and the idle capture waits too before it closes a conversation. A vault write that depends on what's there (a consolidation, an `index.md` update, a promotion) decides inside the same queue the write goes through, so a concurrent update is never lost. The nightly review rewrites or deletes only the version of a document it read, and rereads it when someone changed it meanwhile.

The core doesn't limit how many requests reach the model at once: that's the Ollama server's call, through `OLLAMA_NUM_PARALLEL` (how many requests one loaded model serves together, the rest queue). With more people than that talking at the same time, someone waits for a free slot. The summaries and extractions that run after a turn use the same model, so they take slots too.

## Requirements

Bun: the package ships its TypeScript source, which Bun runs as is, plus type declarations for your editor and `tsc`.

MIT
