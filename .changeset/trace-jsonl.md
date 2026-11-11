---
"@mercury-fw/trace-jsonl": minor
---

- new package: `jsonlTraces({ keepDays? })`, a trace sink writing a JSONL file per day in `.mercury/traces/`, keeping the last `keepDays` days with activity (7 by default)
