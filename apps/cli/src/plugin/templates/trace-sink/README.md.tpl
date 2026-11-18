# __PACKAGE__

The __TITLE__ trace sink: sends the events of what the agent does to an HTTP endpoint, a batch at a time. `mfw plugin create` wrote it as a starting point for a sink of its own.

## Contents

- [Settings](#settings)
- [How it works](#how-it-works)
- [Testing](#testing)

## Settings

`__CONSTANT___URL` in the app's env file: where the batches go, as `POST` requests with a JSON list of events. Without it the sink doesn't load: the agent records no traces and starts anyway.

## How it works

- `write` adds the event to the batch and returns at once: it never throws and never waits.
- A batch goes once it holds 100 events, and on `flush` (the core flushes when it stops).
- A batch that fails is logged and dropped.
- The events come already cut to the instance's trace level, their person and session pseudonymised.
- `build` also gets `ctx.dir`, a folder on the instance's volume that is the sink's own, for a sink writing files.

## Testing

`bun test` in this folder, or `bun run test` in the app's.
