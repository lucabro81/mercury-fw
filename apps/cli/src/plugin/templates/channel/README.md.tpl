# __PACKAGE__

The __TITLE__ channel: people talk to the agent with an HTTP request and get the answer back as JSON. `mfw plugin create` wrote it as a starting point for a channel of its own, such as a chat platform's webhook.

## Contents

- [Settings](#settings)
- [The request](#the-request)
- [What a channel does](#what-a-channel-does)
- [Testing](#testing)

## Settings

- `__CONSTANT___PORT` in the app's env file: the port it listens on, 4200 unless set. Publish it in `docker-compose.yml` to reach it from outside the container.
- An auth provider (`auth` in `mercury.config.ts`): it says who is calling. Without one the channel doesn't start, and the log says why.

## The request

`POST /message` with the caller's credentials and `{ "text": "…", "conversation": "…" }` (`conversation` keeps several conversations apart, `main` unless given). The answer is `{ "text": "…" }`; when the turn staged an irreversible action, `confirm` carries its summary and token, and the person confirms by sending the token as their next message.

## What a channel does

- Who is talking (`ctx.authenticate`) and whether the agent talks to them (`ctx.admit`).
- A confirmation token runs its staged action, never the model (`ctx.confirm`).
- The turn (`handleTurn`), with a sink collecting the answer; `onTextChunk` and `onToolStart` are there for a channel that streams.
- The person's language for its own texts (`ctx.i18n`, `messages.ts`).
- `notify` reaches a person outside a turn; this channel can't, so it does nothing.

## Testing

`bun test` in this folder, or `bun run test` in the app's.
