# @mercury-fw/core

The runtime of [Mercury](https://github.com/lucabro81/mercury-fw): it builds an agent from the config an app gives it and runs it, from the conversation loop to the channels. An app depends on it; a plugin doesn't (plugins build on [`@mercury-fw/kit`](https://www.npmjs.com/package/@mercury-fw/kit)).

The usual way to get it is scaffolding an app, which wires it up for you:

```bash
bun create mercury-agent my-agent
```

## What it exports

- `defineMercuryConfig(config)` types the app's `mercury.config.ts`: `plugins`, `channels`, `auth` (the provider that tells a channel like HTTP who is calling, or a list of them tried in order, the first that recognizes the caller deciding; each provider's people are its own, so the same person coming in through two providers is two people; HTTP doesn't start without one), `directory` (who that is to Mercury, with their roles; a closed instance for anyone it doesn't know), `access` (whether unknown people are let in, what they're told, and which roles a plugin is restricted to), `persona`.
- `composeMercury(config)` builds the agent from that config and the environment, and returns what the entrypoints start: `handleTurn`, the declared channels with their runtime, and the background jobs (`startCrons`).
- `loadChannels(channels, { runtime })` turns the declared channels into started providers, and `createTerminalProvider(...)` opens the dev REPL on `handleTurn`.
- `DEFAULT_PERSONA_IDENTITY`, `DEFAULT_PERSONA_TONE` are the persona an app gets when its config sets none, both referring to the assistant's name as `{{assistant}}`.
- `assistantNameOf(persona)` is the assistant's name (`persona.name`, Mercury by default), refusing one that can't stand in a prompt: blank, longer than 40 characters, on more than one line. `composeMercury` refuses to start on such a name.

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

## How Mercury remembers a conversation

A language model remembers nothing between one answer and the next. Every time it answers, it gets the whole conversation again as text, from the first message to the last, and reads it from scratch. That text has a size limit, the model's context window, so a long conversation can't be handed over forever as it is.

Mercury keeps four things for every conversation:

- **the history**, the conversation as the model gets it, kept in memory while the conversation is active;
- **its summary**: when the history grows past about 60,000 characters, its older part is replaced by a summary written by the model, and the conversation goes on from the summary plus the recent messages (this is called compaction);
- **the archive**, every message word for word, kept in the vector store (Qdrant) and never summarized: it's what a UI shows when it reopens a conversation, and what the model can search when it needs an exact quote;
- **the long-term memory**: short summaries of what was said, which Mercury uses in later conversations to remember the person.

The history lives in the process's memory, so Mercury frees it once a conversation has been quiet for a while (`SESSION_IDLE_TIMEOUT_MS`, 30 minutes by default). Before freeing it, it writes its summary to the long-term memory.

What happens next depends on the channel:

- **On a channel with a single stream of messages**, like a Google Chat space, a quiet stretch closes the conversation. The next message starts a new one, with a reminder of the last one at the top.
- **On a channel where one person keeps many conversations and reopens them whenever they want**, like the HTTP surface behind a web chat, a conversation never ends. Freeing the history only empties a cache: the next message rebuilds it from the archive, as a compaction would, with the summaries of the older part and the newest messages word for word. To the model, and to the person, it's the conversation that was on screen. Whatever comes back is already in the long-term memory, so only the new messages go there.

| Variable | |
|---|---|
| `SESSION_IDLE_TIMEOUT_MS` | How long a quiet conversation keeps its history in memory (default 30 minutes). Lower it to free memory sooner. A reopened conversation on HTTP doesn't notice. |
| `SESSION_RESUME_MAX_CHARS` | How many characters of a reopened conversation come back to the model (default 30,000). Raise it to give the model more of the past, at the cost of a longer prompt on every answer, which a small model or slow hardware pays for. `0` turns resuming off where the channel doesn't set its own. |
| `HTTP_SURFACE_RESUME_MAX_CHARS` | The same, for the HTTP surface only; see [its README](../../channels/channel-http/README.md). |

An example. Someone writes "my favourite colour is green" in a web chat and closes the tab. An hour later Mercury has freed that conversation. When they open it again and ask "what's my favourite colour?", Mercury reads the end of the conversation from the archive, puts it back in front of the model, and the answer is "green", as if no time had passed.

## Who sees what

The core keeps one identity per person, `<provider>:<id>` (`google-chat:users/42`, `oidc:<sub>`), so two providers issuing the same id are still two people. Memory, the conversation archive, the tool log and pending confirmations are kept per person, and a confirmation can only be confirmed by whoever staged it.

The wiki has a common area, `curated/`, that everyone reads, and an area per person under `users/<key>/`, which the model sees as `personal/`: `personal/notes/` is what it writes for that person, `personal/inferred/` what consolidation learned about them. Nobody sees anyone else's area. The model can't write the common area directly: `promote_note` copies one of the person's notes there, and only once they confirm it with the token. The operator's tools (`mfw vault`, the nightly review) still see the whole vault.

An instance that ran an earlier version gets its data moved at startup: Google Chat and terminal notes into their areas, the memory's ids onto the new keys. An id that doesn't say which provider it came from stays where it is, with a line in the log.

## Several people at once

Different people, and different conversations of one person, run in parallel. Turns of one conversation run one after the other: a second message sent while the first is still being answered (two tabs on one chat, a double submit) waits for it, and the idle capture waits too before it closes a conversation. A vault write that depends on what's there (a consolidation, an `index.md` update, a promotion) decides inside the same queue the write goes through, so a concurrent update is never lost. The nightly review rewrites or deletes only the version of a document it read, and rereads it when someone changed it meanwhile.

The core doesn't limit how many requests reach the model at once, so the model server decides how they share it (on Ollama, `OLLAMA_NUM_PARALLEL`). The summaries and extractions that run after a turn use the same model too. Measure it on your own hardware before counting on it: on one setup, a follow-up that took 5 seconds for one person took about two minutes with two people talking at once.

## Requirements

Bun: the package ships its TypeScript source, which Bun runs as is, plus type declarations for your editor and `tsc`.

MIT
