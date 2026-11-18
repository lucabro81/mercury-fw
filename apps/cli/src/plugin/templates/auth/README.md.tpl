# __PACKAGE__

The __TITLE__ auth provider: tells a channel that takes credentials (HTTP) who is calling, from an API key per person. `mfw plugin create` wrote it as a starting point: a provider asking an identity service goes where `authenticate` reads the request.

## Contents

- [Settings](#settings)
- [How it works](#how-it-works)
- [Testing](#testing)

## Settings

`__CONSTANT___KEYS` in the app's env file: `key=id` pairs separated by commas. Without it, or with a malformed one, the provider doesn't load, and the channels needing it don't open.

## How it works

- A request carries `Authorization: Bearer <key>`; the provider answers with the person (`{ id, provider: "__NAME__" }`) or `null`.
- Keys are compared by their SHA-256 digests, in constant time.
- People's keys in the core are `__NAME__:<id>`: a directory (`directory` in `mercury.config.ts`) gives them their roles.

## Testing

`bun test` in this folder, or `bun run test` in the app's.
