# __PACKAGE__

The __TITLE__ directory: who people are and their roles. `mfw plugin create` wrote it as a starting point: it reads them from a setting, and a directory asking an identity service goes in `resolve`.

## Contents

- [Settings](#settings)
- [How it works](#how-it-works)
- [Testing](#testing)

## Settings

`__CONSTANT___PEOPLE` in the app's env file, a JSON list:

```json
[{ "id": "ada", "displayName": "Ada", "roles": ["admin"], "identities": [{ "provider": "static", "id": "ada" }] }]
```

Without it, or with a malformed one, the directory doesn't load and the agent lets in nobody but the terminal.

## How it works

- A channel says who is talking (a provider and an id); `resolve` answers with the person whose identities include it, or `null`.
- Its name can't be one an auth provider or a channel of the instance gives its people (nor `google-chat`, `oidc`, `oidc-<name>`, `static`, `none`): the directory wouldn't load.
- The core keys the person as `__NAME__:<id>`, and their roles decide what they may make the agent do (`access` in `mercury.config.ts`).
- When it can't tell (a service down), `resolve` throws: the core refuses, it never guesses.

## Testing

`bun test` in this folder, or `bun run test` in the app's.
