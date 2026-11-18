# __PACKAGE__

The __TITLE__ vector index: the spaces of points the memory plugins search by meaning. `mfw plugin create` wrote it as a starting point: it keeps them in memory, gone on a restart, and a real index goes behind the same methods.

## Contents

- [Declaring it](#declaring-it)
- [What an index does](#what-an-index-does)
- [Testing](#testing)

## Declaring it

`mfw plugin create` set it as `vectorIndex` in `mercury.config.ts`, unless the app declared another one: then it printed the lines to change. An index needs an embedding model (`models.embedding`).

## What an index does

- `ensure` makes a space once, with the length of its vectors and the fields it's filtered and ordered on.
- `upsert` adds points, replacing one with the same id.
- `query` answers with the nearest points first, `scroll` lists them in an order a page at a time, both within the filter `where` gives.
- `setPayload` rewrites fields of the points a filter selects.
- `health` says whether the database answers. Every method may reject when it doesn't: the core takes that as the index being away for now.

## Testing

`bun test` in this folder, or `bun run test` in the app's. The tests are what the contract asks of every index: run them against the real one when it replaces the map.
