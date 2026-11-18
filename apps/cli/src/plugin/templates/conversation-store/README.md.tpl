# __PACKAGE__

The __TITLE__ conversation store: every message of every conversation, word for word, and each conversation's title. `mfw plugin create` wrote it as a starting point: it keeps them in memory, gone on a restart, and a real store goes behind the same methods.

## Contents

- [Declaring it](#declaring-it)
- [What a store does](#what-a-store-does)
- [Testing](#testing)

## Declaring it

`mfw plugin create` set it as `conversationStore` in `mercury.config.ts`, unless the app declared another one: then it printed the lines to change.

## What a store does

- `ready` gets it ready to be written and read; the core retries it while it rejects.
- `append` keeps a message (`StoredMessage`), as the archive plugin writes it.
- `messages` reads one conversation of one person in time order, a page at a time; `recent` reads the person's newest across their conversations.
- `setTitle` and `titles` keep each conversation's title, the newest replacing the one before.
- `health` says whether the database answers. Every method may reject when it doesn't: the core takes that as the store being away for now.

## Testing

`bun test` in this folder, or `bun run test` in the app's. The tests are what the contract asks of every store: run them against the real one when it replaces the arrays.
