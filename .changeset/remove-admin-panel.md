---
"@mercury-fw/core": minor
"@mercury-fw/cli": minor
---

The admin panel is gone.

- Breaking, `@mercury-fw/core`: `composeMercury` no longer returns `startAdmin`, and `ADMIN_PANEL_ENABLED`/`ADMIN_PANEL_PORT` do nothing. An existing app removes the two lines of its `src/index.ts` that start and stop it (`const adminServer = app.startAdmin();` and `adminServer?.stop();`).
- New apps don't start it.
- What it showed is in the HTTP surface's read routes, scoped to the caller, and in `mfw vault` / `mfw memory` for the operator.
