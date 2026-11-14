---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/plugin-types": minor
"@mercury-fw/channel-http": minor
---

- `output` in `mercury.config.ts`: `"text"` (the default), `{ tool: toolOf(plugin, name) }` (that tool's whole result ends the turn) or `{ schema }` (an object matching the schema)
- `output.validate` checks each value, its error told to the model; `output.retries` (default 2) is how many times the model tries again
- a turn with no accepted output fails with `TurnOutputError` (`code`: `output-missing`, `output-invalid`, `output-tool-unavailable`; `attempts`, `lastError`), recognized with `isTurnOutputError`
- with `output: { schema }` and no plugin tools on the turn, one call bound to the schema; with plugin tools, the tools first, then one call bound to the schema
- with an output other than text: no answer streamed, no post-turn guards, no displays appended, an opening turn says nothing; the conversation keeps the value as indented JSON
- `toolOf`, `TurnOutputConfig`, `Validate`, `OutputVerdict` exported by `@mercury-fw/core`
- `ChannelPlugin.outputs` declares the outputs a channel takes besides text (`channelOutputs`); an agent whose `output` a channel doesn't take doesn't start
- `FinalizeInfo.output`: a turn's `{ mode, value }`, beside the value as indented JSON
- `TurnRecordOfTurn.answer.output`, with the types `OutputMode` and `TurnOutput`
- a `turn.output` trace event: mode, attempts, outcome
- channel-http takes `tool` and `schema` outputs: `final` carries `output`, a `TurnOutputError` is an `error` event with `code`, `attempts`, `lastError`
- channel-http needs the framework at 0.76 or later (peer range raised)
