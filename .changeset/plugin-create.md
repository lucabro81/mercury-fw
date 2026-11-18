---
"@mercury-fw/cli": minor
---

- `mfw plugin create <kind> <name>`: writes a working plugin of the app's own under `plugins/<name>`, with its tests and a README, declares it in `package.json` and in `mercury.config.ts` (or prints the lines to add), runs `bun install`
- kinds: `tool`, `cli` (`--cli-binary`, `--cli-repo`, `--cli-version`), `memory`, `context-strategy`, `channel`, `auth`, `directory`, `trace-sink`, `vector-index`, `conversation-store`
