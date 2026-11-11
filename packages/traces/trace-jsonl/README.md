# @mercury-fw/trace-jsonl

Writes the traces of a [Mercury](https://github.com/lucabro81/mercury-fw) agent to files: one JSON line per event, one file per day. It's the sink `mfw create` puts in a new app, and the simplest one to read: `grep`, `jq` and `tail -f` are enough. It moves with the framework, at the same version as `@mercury-fw/core`.

On Mercury's documentation site: [Traces](https://lucabro81.github.io/mercury-fw/concepts/traces/).

```ts
import { jsonlTraces } from "@mercury-fw/trace-jsonl";

traces: { sink: jsonlTraces() },                 // level "meta"
traces: { sink: jsonlTraces({ keepDays: 14 }), level: "args" },
```

| Option | |
|---|---|
| `keepDays` | How many days with activity to keep, 7 when left out. A whole number from 1 up; anything else stops the app at startup. |

The files go in the folder the core gives the sink, `.mercury/traces/` on the vault's volume, named after the UTC day of their events (`2026-11-11.jsonl`). The core has already cut each event to the instance's level and replaced who someone is with a pseudonym, so what's in a file is what the level allows, nothing more.

`keepDays` counts days with activity, not calendar days: an agent that works two days and then sits idle for a month still has those two days. Older day files go when the agent starts and when a new day's first event arrives; any other file in the folder is left alone.

A write that fails (a full or read-only volume) never reaches the turn that caused it: it's logged once, and events are lost until writing works again.
