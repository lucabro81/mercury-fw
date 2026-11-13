---
title: Traces
description: The record of what the agent did, event by event, kept for a few days so you can see what went wrong and why.
sidebar:
  order: 9
---

The service's log tells you what's happening right now, one line of text at a time. A **trace** is something else:
every time the agent does something (starts a turn, asks the model, calls a tool, saves something to memory) it writes
an **event**, a small record with the same fields every time. Events of the same turn carry the same id, so a turn
can be followed from the message that started it to the answer, with how long each step took and how it went.

Traces are for whoever runs the agent: to find out why an answer was slow, which tool keeps failing, what the
memory decided to keep. The people talking to the agent never see them.

## Turning them on

An app made with `mfw create` already records them. In `mercury.config.ts`:

```ts title="mercury.config.ts"
import { jsonlTraces } from "@mercury-fw/trace-jsonl";

traces: { sink: jsonlTraces(), level: "meta" },
```

- `sink` is where the events go. `jsonlTraces()` writes them to files in the agent's data folder, one per day, in
  `traces/`.
- `level` is how much each event carries (see below). Left out, it's `meta`.

Without `traces`, nothing is recorded.

## What an event says

Each event is one line of JSON. A turn that called one tool leaves something like this:

```json
{"at":"2026-11-11T09:30:00.000Z","kind":"turn.start","turn":"4f1c…","session":"9a0e3b1c7d2f4e5a","person":"c81d2e3f4a5b6c7d","channel":"http","opening":false,"resumed":false,"multiUser":false}
{"at":"2026-11-11T09:30:04.120Z","kind":"model.step","turn":"4f1c…","step":0,"model":"qwen3.8:27b","finishReason":"tool-calls","inputTokens":5412,"outputTokens":38,"loadMs":0,"prefillMs":2810,"generationMs":1240,"totalMs":4100,"toolCalls":1}
{"at":"2026-11-11T09:30:05.020Z","kind":"tool.call","turn":"4f1c…","tool":"jiraCommand","outcome":"success","durationMs":880,"resultChars":2140}
{"at":"2026-11-11T09:30:09.700Z","kind":"turn.end","turn":"4f1c…","outcome":"done","durationMs":9700,"steps":2,"toolCalls":1,"answerChars":312,"reasoningChars":0,"stoodIn":false}
```

`prefillMs` is how long the model took to read the prompt before writing the first word, `generationMs` how long it
took to write: two different costs, and the first one grows with everything that goes into the prompt.

What gets recorded:

| Kind | When |
|---|---|
| `turn.start`, `turn.end` | A turn begins and ends: how it ended (done, failed, cancelled, stalled, refused…), how long it took, how many steps and tool calls. |
| `model.step` | The model finished a step: tokens read and written, time to load, read the prompt and write. |
| `tool.call` | A tool ran: which, how it went, how long, how big its result was. |
| `confirmation.staged`, `confirmation.resolved` | An action waits for a confirmation, and how it was resolved. |
| `history.compressed` | A long conversation was shortened to fit (summarized, or its oldest messages dropped), as the plugin keeping it reported: how much, how long it took. |
| `context.assembled` | What the [context](../context/) added before the model answered: the profile, and for each layer how many characters and blocks it added, how many it left out for the budget, or why it was skipped. |
| `context.changed` | Someone changed a [context](../context/) profile while the agent ran: which profile, which of its budget, order and knobs; the values before and after only at the `args` level. |
| `guard.run` | A plugin's check on the answer ran, and whether it changed it. |
| `plugin.hook` | A plugin's code after a turn, on what a turn or a confirmation left (`onTurnRecord`, where the archive writes), or after a conversation closed, finished: which plugin, how long it took, whether it worked. |
| `session.closed` | A quiet conversation was saved and freed. |
| `background.job` | A piece of work nobody waits on ran (a plugin's job, named `<plugin>:<job>`: what the memory keeps of a conversation is `memory:capture`, the index of the messages `memory:archive-index`, a correction `corrections:correction`, a conversation's title `titles:title`, the wiki's nightly review is `wiki:review-raw`, `wiki:review-index` and `wiki:review-contradictions`): on which models, in how many model calls, how long they waited for the model and how long it took in all, and whether it was done, failed or dropped when the agent stopped. One that needed no model call (a title already there, say) isn't recorded. |
| `system.start`, `system.channels` | The agent started: the model of each role with its capacity, plugins and channels running, and the ones left out with the reason; whether it has a vector index and a conversation store. |
| `system.migrated` | The agent copied state an older version kept elsewhere: which area, and what it copied. |
| `system.error`, `system.recovered` | Something failed without stopping the agent (the memory store unreachable, a login that didn't finish), and when it came back. |

## Who is who

An event never says who someone is. The person and the conversation are replaced by a **pseudonym**: 16 characters
that are always the same for the same person, so you can tell that ten slow turns were all the same person's, but not
who that person is. The pseudonyms come from a secret the agent makes on its first start and keeps in
`trace-secret`, in its data folder; delete it and the next start makes new ones.

The text of the conversation never enters a trace either. Each event carries the turn's id, and the archived messages
of that turn carry the same one: when you need to read what was said, the archive has it.

## How much an event carries

| Level | What's in it |
|---|---|
| `meta` | Names, outcomes, durations, sizes. |
| `args` | Also what the tools were given (a command, a query, cut to 500 characters a string), the summary of an action waiting for confirmation, and the error messages. |

`meta` is the safe default. `args` is for when you're chasing a bug and need to see the command that failed.

## Reading them

The files are in the agent's data folder, in its container: `$MERCURY_DATA_PATH/traces/`, one per day. From
the app's folder, everything one turn did, in order, straight from the container:

```bash
docker compose exec -T mercury sh -c 'grep -h "\"turn\":\"4f1c" "$MERCURY_DATA_PATH"/traces/*.jsonl'
```

To dig further, copy them to your machine and read them with [`jq`](https://jqlang.org/), which the container doesn't
have:

```bash
docker compose exec -T mercury sh -c 'cat "$MERCURY_DATA_PATH"/traces/*.jsonl' > traces.jsonl
```

The slowest turns, for instance:

```bash
jq -r 'select(.kind == "turn.end") | "\(.durationMs) \(.outcome) \(.turn)"' traces.jsonl | sort -n | tail
```

## How long they're kept

The last 7 days with activity: a day nobody talked to the agent doesn't count, so an agent used two days and then
left alone for a month still has those two days. To keep more, `jsonlTraces({ keepDays: 14 })`.
