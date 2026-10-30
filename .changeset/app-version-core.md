---
"@mercury-fw/core": minor
"@mercury-fw/channel-types": minor
---

An app can show its own version next to the framework's.

- `version` in `mercury.config.ts`: the app's version, as its `package.json` has it. The core hands it to the channels as `ctx.appVersion`, trimmed and otherwise as written; left out or empty, channels get none.
- Mercury only shows that number: moving it is up to the app (by hand, with Changesets, or with a script before pushing), and a new one shows once the app is rebuilt.

An existing app that wants it adds two lines to `mercury.config.ts`: `import pkg from "./package.json";` at the top, and `version: pkg.version,` in `defineMercuryConfig`. The HTTP channel's `GET /version` shows it to anyone, with no token: leave it out to show none.
