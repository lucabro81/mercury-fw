---
"@mercury-fw/cli": minor
"@mercury-fw/kit": patch
---

- `mfw create`: new apps get an `AGENTS.md` and the `mercury-plugin` skill (`.claude/skills/`, `.agents/skills/`), for a coding assistant working on the app and writing its plugins
- `mfw agent-files`: writes them into an existing app, keeping any file already there
- kit README: a minimal plugin, sections, and the way to start one (`mfw plugin create`)
- **Migration:** to give an existing app `AGENTS.md` and the `mercury-plugin` skill, run `mfw agent-files` in it
