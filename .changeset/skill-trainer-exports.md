---
"@mercury-fw/core": minor
"@mercury-fw/cli": minor
---

- `@mercury-fw/core` exports `OPERATOR_PRINCIPAL`, the terminal's principal, for a caller that drives `handleTurn` itself as the operator.
- `@mercury-fw/cli/e2e` exports `turnFromDump` and `createExpect`, so a tool running Mercury turns of its own reads and checks them the way `mfw e2e` does.
