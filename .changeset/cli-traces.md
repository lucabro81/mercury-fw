---
"@mercury-fw/cli": minor
---

- `mfw create`: new apps declare `traces: { sink: jsonlTraces(), level: "meta" }` and depend on `@mercury-fw/trace-jsonl`
- **Migration:** to record traces, `bun add @mercury-fw/trace-jsonl` at the framework's version, add `import { jsonlTraces } from "@mercury-fw/trace-jsonl";` and `traces: { sink: jsonlTraces(), level: "meta" },` to `mercury.config.ts`, then in `src/index.ts` pass `tracer: app.tracer` to `loadChannels` and `await app.tracer.flush();` before `process.exit(0)` in `shutdown`
