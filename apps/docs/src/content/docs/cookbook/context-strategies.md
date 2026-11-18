---
title: Comparing context strategies
description: Swapping the conversation window for the files strategy, and reading what each costs from the traces.
sidebar:
  order: 7
---

The task: the agent's tools return long outputs, and you want to know whether keeping them in files (the
`context-files` strategy) costs less than the conversation window every app starts with. A context strategy is a
profile's `conversation`; [Memory](../../concepts/memory/#context-strategies) explains both.

## Swapping it

```bash
bun add @mercury-fw/context-files
```

```ts title="mercury.config.ts"
import { contextFiles } from "@mercury-fw/context-files";

const conversation = contextFiles({ earlier: longTermMemory });
```

in place of `conversationWindow(...)`: the profile and `plugins` already name `conversation`, so nothing else changes.
With it, a tool output over 4,000 characters goes to a file, and the model gets the file's name and first lines, then
reads it in pieces with `read_context_file` and `search_context_files`.

## Measuring

Every model call is a `model.step` event in the traces, with `inputTokens`; with the default sink they're JSON lines in
`traces/` in the app's data folder. Run the same turns under each strategy, then:

```bash
docker compose exec mercury sh -c 'cat /app/data/traces/*.jsonl' \
  | jq -c 'select(.kind=="model.step" or .kind=="turn.start") | if .kind=="turn.start" then "turn" else .inputTokens end'
```

Three turns on a tool listing 200 items (the example tool of `mfw plugin create tool payroll`, its service a stand-in
returning about 20,000 characters), on qwen3.8:27b, input tokens of each model call:

| Turn | `conversationWindow` | `contextFiles` |
|---|---|---|
| "List the payroll items: how many are there?" | 3,280 · 3,488 · 9,381 | 4,320 · 4,974 |
| "And how many of them are bonuses?" | 3,551 · 4,773 · 10,862 | 4,658 · 9,310 · 14,396 |
| "Which is the first bonus, by id?" | 3,900 | 5,221 |

The files strategy cut the first turn by about two fifths: the list went to a file, and the model answered without the whole list in its context. The
second turn cost more under it: the model read the file in pieces to count the bonuses, while under the window it
called the tool again and read the whole list in one step. Neither is cheaper in general: it depends on what the
turns do with the outputs. Measure on your own turns, and run your e2e tests under each before choosing.

## Your own strategy

`bunx mfw plugin create context-strategy <name>` writes one from scratch, with the window and the four methods a
strategy decides what the model reads through; the traces measure it the same way.
